package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	wa "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/store/sqlstore"
	"github.com/polymorfa/hypermeow/types"
	mc "github.com/purpshell/meowcaller"
	"github.com/rs/zerolog"
	"github.com/skip2/go-qrcode"
	_ "modernc.org/sqlite"
)

func main() {
	log.SetFlags(log.Ltime)
	if len(os.Args) == 2 && os.Args[1] == "--help" {
		fmt.Println("babata-vc-probe (pair or one outbound test call)\nSet VC_TARGET and VC_VIDEO for a call; leave both empty for pairing only.")
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Printf("[VC TEST] FAILED: %v", err)
		os.Exit(1)
	}
}
func run(ctx context.Context) error {
	target, video := os.Getenv("VC_TARGET"), os.Getenv("VC_VIDEO")
	if (target == "") != (video == "") {
		return errors.New("VC_TARGET dan VC_VIDEO harus diisi bersama")
	}
	if target != "" && !regexp.MustCompile(`^[1-9][0-9]{7,14}$`).MatchString(target) {
		return errors.New("VC_TARGET harus nomor internasional tanpa +")
	}
	if target != "" && os.Getenv("VC_CONFIRM") != "YES" {
		return errors.New("Set VC_CONFIRM=YES hanya untuk nomor uji yang menyetujui panggilan")
	}
	dir := "vc-private"
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	qrPath := filepath.Join(dir, "pair.png")
	defer os.Remove(qrPath)
	var frames [][]byte
	var audio string
	if video != "" {
		var err error
		frames, audio, err = encode(ctx, video, dir)
		if err != nil {
			return err
		}
		if audio != "" {
			defer os.Remove(audio)
		}
	}
	db, err := sqlstore.New(ctx, "sqlite", "file:vc-private/session.db?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)", nil)
	if err != nil {
		return fmt.Errorf("session store: %w", err)
	}
	defer db.Close()
	device, err := db.GetFirstDevice(ctx)
	if err != nil {
		return err
	}
	client := wa.NewClient(device, nil)
	engine := mc.NewClient(client, mc.WithLogger(zerolog.New(safeEngineLog{}).Level(zerolog.DebugLevel)))
	log.Println("[VC TEST] DIAGNOSTIC V2 (no raw packet dump)")
	defer client.Disconnect()
	if client.Store.ID == nil {
		qr, err := client.GetQRChannel(ctx)
		if err != nil {
			return err
		}
		if err = client.Connect(); err != nil {
			return err
		}
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case evt, ok := <-qr:
				if !ok {
					goto paired
				}
				if evt.Event == "code" {
					if err = qrcode.WriteFile(evt.Code, qrcode.Medium, 320, qrPath); err != nil {
						return err
					}
					_ = os.Chmod(qrPath, 0600)
					log.Println("[VC TEST] QR tersedia di vc-private/pair.png (jangan dibagikan)")
				} else {
					log.Printf("[VC TEST] PAIR EVENT %s", evt.Event)
				}
			}
		}
	} else if err := client.Connect(); err != nil {
		return err
	}
paired:
	_ = os.Remove(qrPath)
	deadline := time.NewTimer(75 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for !client.IsConnected() || !client.IsLoggedIn() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("login timeout")
		case <-ticker.C:
		}
	}
	log.Println("[VC TEST] LOGIN OK")
	if client.Store.PushName == "" {
		client.Store.PushName = "Babata VC Test"
	}
	if err := client.SendPresence(ctx, types.PresenceAvailable); err != nil {
		log.Println("[VC TEST] Presence failed")
	}
	if target == "" {
		log.Println("[VC TEST] Pairing complete. No call made.")
		return nil
	}
	dialCtx, cancel := context.WithTimeout(ctx, 75*time.Second)
	defer cancel()
	log.Println("[VC TEST] DIAL START")
	call, err := engine.CallWithOptions(dialCtx, target, mc.CallOptions{Video: true})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer call.Hangup()
	ready := make(chan struct{}, 1)
	ended := make(chan string, 1)
	call.OnPeerAccept(func() { log.Println("[VC TEST] PEER ACCEPTED") })
	call.OnStateChange(func(p mc.CallPhase) { log.Printf("[VC TEST] PHASE %d", p) })
	call.OnReady(func() {
		select {
		case ready <- struct{}{}:
		default:
		}
	})
	call.OnEnd(func(reason string) {
		select {
		case ended <- reason:
		default:
		}
	})
	log.Println("[VC TEST] OFFER RETURNED; WAITING MEDIA")
	mediaTimer := time.NewTimer(60 * time.Second)
	defer mediaTimer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case reason := <-ended:
		return fmt.Errorf("call ended before media ready (reason category: %s)", classifyError(reason))
	case <-mediaTimer.C:
		return errors.New("media timeout")
	case <-ready:
		log.Println("[VC TEST] MEDIA READY")
	}
	if audio != "" {
		src, err := mc.WAVFile(audio)
		if err != nil {
			return err
		}
		defer src.Close()
		call.Play(src)
		log.Println("[VC TEST] AUDIO START")
	}
	start := time.Now()
	interval := time.Second / 30
	for i, frame := range frames {
		t := time.NewTimer(time.Until(start.Add(time.Duration(i) * interval)))
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case reason := <-ended:
			t.Stop()
			return fmt.Errorf("ended during stream (reason category: %s)", classifyError(reason))
		case <-t.C:
		}
		if err := call.SendVideoWithDuration(frame, interval); err != nil {
			return fmt.Errorf("send frame %d: %w", i, err)
		}
		if i%30 == 0 {
			log.Printf("[VC TEST] VIDEO FRAME SENT %d/%d", i+1, len(frames))
		}
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(interval):
	case <-ended:
	}
	log.Println("[VC TEST] STREAM API COMPLETED; confirm picture and sound on receiving phone")
	return nil
}
func encode(ctx context.Context, path, dir string) ([][]byte, string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, "", err
	}
	if !info.Mode().IsRegular() {
		return nil, "", errors.New("video bukan file lokal biasa")
	}
	c, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	log.Println("[VC TEST] ENCODE START (max 30 seconds)")
	cmd := exec.CommandContext(c, "ffmpeg", "-v", "error", "-nostdin", "-i", path, "-t", "30", "-an", "-vf", "scale=480:480:force_original_aspect_ratio=decrease,pad=480:480:(ow-iw)/2:(oh-ih)/2,fps=30", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-tune", "zerolatency", "-b:v", "500k", "-maxrate", "600k", "-bufsize", "600k", "-x264-params", "aud=1:repeat-headers=1:keyint=30:min-keyint=30:scenecut=0", "-f", "h264", "pipe:1")
	raw, err := cmd.Output()
	if err != nil {
		return nil, "", fmt.Errorf("ffmpeg H264: %w", err)
	}
	frames := splitAUD(raw)
	if len(frames) == 0 {
		return nil, "", errors.New("no H264 access units")
	}
	wav := filepath.Join(dir, "test-audio.wav")
	cmd = exec.CommandContext(c, "ffmpeg", "-v", "error", "-nostdin", "-y", "-i", path, "-t", "30", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav)
	if err = cmd.Run(); err != nil {
		_ = os.Remove(wav)
		wav = ""
		log.Println("[VC TEST] AUDIO unavailable; testing video only")
	}
	log.Printf("[VC TEST] ENCODE OK %d frames", len(frames))
	return frames, wav, nil
}

// FFmpeg inserts an Access Unit Delimiter before every frame. Preserve start codes and headers.
func splitAUD(raw []byte) [][]byte {
	var starts []int
	for i := 0; i+4 < len(raw); {
		n := 0
		if bytes.HasPrefix(raw[i:], []byte{0, 0, 0, 1}) {
			n = 4
		} else if bytes.HasPrefix(raw[i:], []byte{0, 0, 1}) {
			n = 3
		}
		if n == 0 {
			i++
			continue
		}
		if i+n < len(raw) && raw[i+n]&31 == 9 {
			starts = append(starts, i)
		}
		i += n
	}
	if len(starts) == 0 {
		return nil
	}
	var out [][]byte
	for i := range starts {
		a := starts[i]
		if i == 0 {
			a = 0
		}
		b := len(raw)
		if i+1 < len(starts) {
			b = starts[i+1]
		}
		out = append(out, raw[a:b])
	}
	return out
}

// Only emit diagnostic event descriptions and classified errors, never raw fields,
// credentials, phone numbers, packet dumps, addresses or remote media.
type safeEngineLog struct{}

var safeMessage = regexp.MustCompile(`^[A-Za-z][A-Za-z _/().-]{0,119}$`)

func (safeEngineLog) Write(p []byte) (int, error) {
	var event struct {
		Level   string `json:"level"`
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	if json.Unmarshal(p, &event) != nil {
		return len(p), nil
	}
	if !safeMessage.MatchString(event.Message) {
		event.Message = "structured event (details withheld)"
	}
	switch event.Level {
	case "trace", "debug", "info", "warn", "error", "fatal", "panic":
	default:
		event.Level = "unknown"
	}
	log.Printf("[VC ENGINE] %s %s | error=%s", event.Level, event.Message, classifyError(event.Error))
	return len(p), nil
}
func classifyError(s string) string {
	s = strings.ToLower(s)
	switch {
	case s == "":
		return "none"
	case strings.Contains(s, "timeout") || strings.Contains(s, "deadline"):
		return "timeout"
	case strings.Contains(s, "refused"):
		return "connection-refused"
	case strings.Contains(s, "unreachable"):
		return "network-unreachable"
	case strings.Contains(s, "permission") || strings.Contains(s, "not permitted"):
		return "permission"
	case strings.Contains(s, "authentication") || strings.Contains(s, "decrypt"):
		return "authentication"
	case strings.Contains(s, "dtls"):
		return "dtls"
	case strings.Contains(s, "relay"):
		return "relay"
	case strings.Contains(s, "closed") || strings.Contains(s, "cancel"):
		return "closed-or-cancelled"
	default:
		return "other (details withheld)"
	}
}
