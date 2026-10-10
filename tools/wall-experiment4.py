#!/usr/bin/env python3
# Experiment 4 (nicht Teil des Produkts): Zeigt jede Kachel einer Videowand mit dem berechneten Zuschnitt (shared/wall.js: tileCrop) wirklich ihren Teil des Bildes?
# Läuft unter xvfb-run mit Software-OpenGL (Ubuntu: apt install mpv ffmpeg xvfb libgl1-mesa-dri nodejs):
#   xvfb-run -a -s "-screen 0 1280x720x24" python3 tools/wall-experiment4.py
import json, os, socket, subprocess, time, shutil, struct, zlib

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
D = '/tmp/wall4'; shutil.rmtree(D, ignore_errors=True); os.makedirs(D)

def crops(cols, rows, aspect=16 / 9):
    # Zuschnitte kommen aus shared/wall.js (von Node berechnet und als JSON übergeben): node tools/wall-crops.mjs > Datei; Datei per Umgebungsvariable DFM_CROPS
    return json.load(open(os.environ['DFM_CROPS']))[f'{cols}x{rows}']

def make_image(name, spec):
    # spec: ffmpeg-Filtergraph, der ein 1920x1080-Bild erzeugt
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-filter_complex', spec, '-frames:v', '1', f'{D}/{name}.png'], check=True)

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

def name_of(p):
    r, g, b = p
    if r > 200 and g < 60 and b < 60: return 'rot'
    if g > 150 and r < 60 and b < 60: return 'gruen'
    if b > 200 and r < 60 and g < 60: return 'blau'
    if r > 200 and g > 200 and b < 60: return 'gelb'
    if max(p) < 40: return 'schwarz'
    return f'?{tuple(p)}'

def color_at(img, fx, fy):
    w, h, bpp, rows = img; x = int(fx * (w - 1)); y = int(fy * (h - 1)); return name_of(rows[y][x * bpp:x * bpp + 3])

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

def settle(label, pts):
    last = None
    for _ in range(10):
        time.sleep(0.7)
        out = f'{D}/{label}.png'
        cmd('screenshot-to-file', out, 'window'); time.sleep(0.4)
        if not os.path.exists(out): continue
        img = png_pixels(out); cur = tuple(color_at(img, fx, fy) for fx, fy in pts)
        if cur == last: return cur
        last = cur
    return last

bad = 0
def scenario(title, image, cols, rows, want):
    global bad
    cmd('loadfile', f'{D}/{image}.png', 'replace')
    for _ in range(30):
        r = cmd('get_property', 'video-params/w')
        if r and r.get('error') == 'success': break
        time.sleep(0.3)
    cr = crops(cols, rows)
    print(f'-- {title}  ({cols}x{rows})')
    for i, c in enumerate(cr):
        cmd('set_property', 'video-crop', c)
        got = settle(f'{image}-{i}', [(0.5, 0.5)])[0]
        ok = got == want[i]; bad += 0 if ok else 1
        print(f'   Kachel {i}: crop={c:18s} Mitte={got:8s} {"OK" if ok else "!! erwartet " + want[i]}')

# 4 senkrechte Streifen (rot, grün, blau, gelb), 4x1-Wand mit 16:9-Inhalt: jede Kachel zeigt „ihren“ Streifen
make_image('streifen', "color=c=0xff0000:size=480x1080[a];color=c=0x00ff00:size=480x1080[b];color=c=0x0000ff:size=480x1080[c];color=c=0xffff00:size=480x1080[d];[a][b][c][d]hstack=inputs=4")
scenario('4 Streifen', 'streifen', 4, 1, ['rot', 'gruen', 'blau', 'gelb'])
# 4 Quadranten, 2x2-Wand
make_image('quadranten', "color=c=0xff0000:size=960x540[a];color=c=0x00ff00:size=960x540[b];color=c=0x0000ff:size=960x540[c];color=c=0xffff00:size=960x540[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack")
scenario('4 Quadranten', 'quadranten', 2, 2, ['rot', 'gruen', 'blau', 'gelb'])
cmd('quit')
try: p.wait(timeout=5)
except Exception: p.kill()
print('Alles wie berechnet' if not bad else f'{bad} Abweichung(en)')
raise SystemExit(1 if bad else 0)
