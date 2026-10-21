package monitor

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net"
	"time"

	"github.com/AgroDan/packetatlas/internal/config"
	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

// pingChecker sends ICMP echo requests. It first tries an unprivileged
// "ping socket" (Linux: net.ipv4.ping_group_range must include our GID) and
// falls back to a raw socket (needs root or CAP_NET_RAW).
type pingChecker struct {
	target *config.Target
}

func (p *pingChecker) Check(ctx context.Context) Result {
	cfg := p.target.Ping
	ip, err := resolveIP(ctx, cfg.Host)
	if err != nil {
		return Result{State: StateDown, Err: err.Error()}
	}

	conn, dst, proto, privileged, err := listenICMP(ip)
	if err != nil {
		return Result{State: StateUnknown, Err: err.Error()}
	}
	defer conn.Close()

	var echoType, replyType icmp.Type = ipv4.ICMPTypeEcho, ipv4.ICMPTypeEchoReply
	if proto == 58 {
		echoType, replyType = ipv6.ICMPTypeEchoRequest, ipv6.ICMPTypeEchoReply
	}

	id := rand.IntN(0xffff)
	baseSeq := rand.IntN(0x7fff)
	perPing := p.target.Timeout.Duration
	var received int
	var total time.Duration
	buf := make([]byte, 1500)

	for i := 0; i < cfg.Count; i++ {
		if ctx.Err() != nil {
			break
		}
		seq := (baseSeq + i) & 0xffff
		msg := icmp.Message{Type: echoType, Body: &icmp.Echo{ID: id, Seq: seq, Data: []byte("packetatlas")}}
		b, err := msg.Marshal(nil)
		if err != nil {
			return Result{State: StateUnknown, Err: err.Error()}
		}
		start := time.Now()
		if _, err := conn.WriteTo(b, dst); err != nil {
			return Result{State: StateDown, Err: err.Error()}
		}
		_ = conn.SetReadDeadline(start.Add(perPing))
		for {
			n, _, err := conn.ReadFrom(buf)
			if err != nil {
				break // timeout: lost
			}
			rm, err := icmp.ParseMessage(proto, buf[:n])
			if err != nil || rm.Type != replyType {
				continue
			}
			echo, ok := rm.Body.(*icmp.Echo)
			// Unprivileged sockets get their ID rewritten by the kernel, and
			// only receive their own replies, so match on seq alone there.
			if !ok || echo.Seq != seq || (privileged && echo.ID != id) {
				continue
			}
			received++
			total += time.Since(start)
			break
		}
		if i < cfg.Count-1 {
			time.Sleep(200 * time.Millisecond)
		}
	}

	loss := 100 * float64(cfg.Count-received) / float64(cfg.Count)
	res := Result{Detail: fmt.Sprintf("%s · %d/%d replies", ip, received, cfg.Count)}
	switch {
	case received == 0:
		res.State = StateDown
		res.Err = "100% packet loss"
	case received < cfg.Count:
		res.State = StateDegraded
		res.Detail += fmt.Sprintf(" (%.0f%% loss)", loss)
	default:
		res.State = StateUp
	}
	if received > 0 {
		res.LatencyMs = float64(total.Microseconds()) / 1000 / float64(received)
	}
	return res
}

func resolveIP(ctx context.Context, host string) (net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return ip, nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, a := range addrs {
		if a.IP.To4() != nil {
			return a.IP, nil
		}
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("no addresses for %s", host)
	}
	return addrs[0].IP, nil
}

func listenICMP(ip net.IP) (conn *icmp.PacketConn, dst net.Addr, proto int, privileged bool, err error) {
	v4 := ip.To4() != nil
	udpNet, rawNet, laddr, proto := "udp4", "ip4:icmp", "0.0.0.0", 1
	if !v4 {
		udpNet, rawNet, laddr, proto = "udp6", "ip6:ipv6-icmp", "::", 58
	}
	if conn, err = icmp.ListenPacket(udpNet, laddr); err == nil {
		return conn, &net.UDPAddr{IP: ip}, proto, false, nil
	}
	if conn, err = icmp.ListenPacket(rawNet, laddr); err == nil {
		return conn, &net.IPAddr{IP: ip}, proto, true, nil
	}
	return nil, nil, 0, false, fmt.Errorf("cannot open ICMP socket (need ping_group_range or CAP_NET_RAW): %w", err)
}
