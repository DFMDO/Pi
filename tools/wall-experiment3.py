#!/usr/bin/env python3
# Experiment 3 (nicht Teil des Produkts): Zeigt mpv mit „video-crop“ in Prozent (ohne Filter) wirklich den berechneten Ausschnitt?
# Läuft unter xvfb-run mit Software-OpenGL: xvfb-run -a -s "-screen 0 1280x720x24" python3 tools/wall-experiment3.py
import json, os, socket, subprocess, time, shutil, struct, zlib

D = '/tmp/wall3'; shutil.rmtree(D, ignore_errors=True); os.makedirs(D)

# Testbild: links rot, rechts blau (1920x1080) – so sieht man sofort, welcher Teil gezeigt wird
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                "color=c=red:size=960x1080,format=rgb24[l];color=c=blue:size=960x1080,format=rgb24[r];[l][r]hstack",
                '-frames:v', '1', f'{D}/rb.png'], check=False)
if not os.path.exists(f'{D}/rb.png'):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-filter_complex', 'color=c=red:size=960x1080[l];color=c=blue:size=960x1080[r];[l][r]hstack', '-frames:v', '1', f'{D}/rb.png'], check=True)

def png_pixels(path):
    data = open(path, 'rb').read(); pos = 8; idat = b''; w = h = 0; ct = 0
    while pos < len(data):
        ln, = struct.unpack('>I', data[pos:pos + 4]); typ = data[pos + 4:pos + 8]; body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', body[:10])
        if typ == b'IDAT': idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat); bpp = 4 if ct == 6 else 3; stride = w * bpp; rows = []; prev = bytearray(stride); i = 0
    for _ in range(h):
        f = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0; b = prev[x]; c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line); prev = line
    return w, h, bpp, rows

def color_at(img, fx, fy):
    w, h, bpp, rows = img; x = int(fx * (w - 1)); y = int(fy * (h - 1)); p = rows[y][x * bpp:x * bpp + 3]
    return 'rot' if p[0] > 200 and p[2] < 60 else 'blau' if p[2] > 200 and p[0] < 60 else 'schwarz' if max(p) < 40 else f'? {tuple(p)}'

sock = f'{D}/sock'
p = subprocess.Popen(['mpv', '--idle=yes', '--vo=gpu', '--gpu-context=x11egl', '--ao=null', '--no-audio', '--msg-level=all=warn', '--geometry=640x360', '--no-border',
                      f'--input-ipc-server={sock}', '--keep-open=yes', '--image-display-duration=inf', '--force-window=yes'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(80):
    if os.path.exists(sock): break
    time.sleep(0.1)
s = socket.socket(socket.AF_UNIX); s.connect(sock); s.settimeout(2.0)
buf = b''
def cmd(*a):
    global buf
    s.sendall((json.dumps({'command': list(a)}) + '\n').encode()); t0 = time.time()
    while time.time() - t0 < 3:
        try: buf += s.recv(65536)
        except Exception: break
        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            try: j = json.loads(line)
            except Exception: continue
            if 'error' in j: return j
    return None

cmd('loadfile', f'{D}/rb.png', 'replace')
for _ in range(30):
    r = cmd('get_property', 'video-params/w')
    if r and r.get('error') == 'success': break
    time.sleep(0.3)
time.sleep(1.0)
def shot(name):
    out = f'{D}/{name}.png'
    r = cmd('screenshot-to-file', out, 'window'); time.sleep(0.5)
    return png_pixels(out) if os.path.exists(out) else None

bad = 0
def check(label, crop, want_left, want_right, pts=(0.1, 0.9)):
    global bad
    cmd('set_property', 'video-crop', crop)
    last = None; got = None
    for i in range(10):  # warten, bis das Bild neu gezeichnet ist (zwei gleiche Ergebnisse hintereinander)
        time.sleep(0.8)
        img = shot(label)
        if img is None: continue
        cur = (color_at(img, pts[0], 0.5), color_at(img, pts[1], 0.5), img[0], img[1])
        if cur == last: got = cur; break
        last = cur
    if got is None: got = last
    ok = got is not None and (got[0], got[1]) == (want_left, want_right); bad += 0 if ok else 1
    if img is not None: print('   Zeile:', ' '.join(color_at(img, x / 20, 0.5)[:2] for x in range(1, 20)), ' Fenster', img[0], img[1])
    print(f'{label:34s} crop={crop:18s} links={got[0] if got else None} rechts={got[1] if got else None} {"OK" if ok else "!! erwartet " + want_left + "/" + want_right}')

check('ganzes_Bild', '', 'rot', 'blau')
check('linke_Haelfte_50%', '50%x100%+0+0', 'rot', 'rot', (0.45, 0.55))  # hochkant → Balken links/rechts, Mitte sichtbar
check('rechte_Haelfte_50%', '50%x100%+50%+0', 'blau', 'blau', (0.45, 0.55))
check('mittlere_Haelfte_25_50', '50%x100%+25%+0', 'rot', 'blau', (0.45, 0.55))
check('mitte_oben_25%', '50%x50%+25%+0', 'rot', 'blau')
cmd('quit')
try: p.wait(timeout=5)
except Exception: p.kill()
print('Alles wie berechnet' if not bad else f'{bad} Abweichung(en)')
