#!/usr/bin/env python3
# Experiment (nicht Teil des Produkts): Prüft mit einem echten mpv, ob der Videowand-Zuschnitt (lavfi crop mit Ausdrücken) so arbeitet wie berechnet.
# Aufruf in WSL/Linux: python3 tools/wall-experiment.py   (braucht mpv und ffmpeg; schreibt nach /tmp/wall)
import json, os, socket, struct, subprocess, sys, time, glob, shutil

D = '/tmp/wall'
shutil.rmtree(D, ignore_errors=True); os.makedirs(D)

def png_size(path):
    with open(path, 'rb') as f:
        h = f.read(24)
    return struct.unpack('>II', h[16:24])

def make_media():
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25:duration=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', f'{D}/hd.mp4'], check=True)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1440x1080:rate=25:duration=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', f'{D}/43.mp4'], check=True)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080', '-frames:v', '1', f'{D}/still.png'], check=True)

def crop_filter(cols, rows, col, row, aspect=(16, 9)):
    aw = f'(({cols}*{aspect[0]})/({rows}*{aspect[1]}))'
    rw = f'min(iw,ih*{aw})'
    w = f'{rw}/{cols}'
    h = f'{rw}/{aw}/{rows}'
    x = f'(iw-{rw})/2+{col}*{w}'
    y = f'(ih-{rw}/{aw})/2+{row}*{h}'
    return f"lavfi=[crop=w='{w}':h='{h}':x='{x}':y='{y}']"

def run_case(media, vf, label, via='set_property'):
    out = f'{D}/out-{label}'
    os.makedirs(out, exist_ok=True)
    sock = f'{D}/sock-{label}'
    p = subprocess.Popen(['mpv', '--idle=yes', '--force-window=no', '--vo=image', '--vo-image-format=png', f'--vo-image-outdir={out}', '--ao=null', '--no-audio', '--msg-level=all=warn',
                          f'--input-ipc-server={sock}', '--keep-open=no', '--cache=no'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        if os.path.exists(sock): break
        time.sleep(0.1)
    s = socket.socket(socket.AF_UNIX); s.connect(sock); s.settimeout(0.5)
    def cmd(*a):
        s.sendall((json.dumps({'command': list(a)}) + '\n').encode())
    if via == 'set_property': cmd('set_property', 'vf', vf)
    else: cmd('vf', 'set', vf)
    time.sleep(0.2)
    cmd('loadfile', media, 'replace')
    time.sleep(1.5)
    cmd('quit')
    try: p.wait(timeout=5)
    except Exception: p.kill()
    log = p.stdout.read().decode(errors='replace').strip()
    files = sorted(glob.glob(f'{out}/*.png'))
    size = png_size(files[0]) if files else None
    print(f'{label:28s} -> {size}  {("LOG: " + log[:200]) if log else ""}')
    return size

make_media()
cases = [
    ('2x1 links  (HD)',  f'{D}/hd.mp4', crop_filter(2, 1, 0, 0), (960, 540)),
    ('2x1 rechts (HD)',  f'{D}/hd.mp4', crop_filter(2, 1, 1, 0), (960, 540)),
    ('2x2 unten rechts', f'{D}/hd.mp4', crop_filter(2, 2, 1, 1), (960, 540)),
    ('3x1 mitte (HD)',   f'{D}/hd.mp4', crop_filter(3, 1, 1, 0), (640, 360)),
    ('2x1 links (4:3)',  f'{D}/43.mp4', crop_filter(2, 1, 0, 0), (720, 405)),
    ('2x2 oben links 4:3', f'{D}/43.mp4', crop_filter(2, 2, 0, 0), (720, 405)),
    ('2x2 Standbild',    f'{D}/still.png', crop_filter(2, 2, 0, 1), (960, 540)),
]
bad = 0
for label, media, vf, want in cases:
    got = run_case(media, vf, label.replace(' ', '_').replace('(', '').replace(')', '').replace(':', ''))
    if got is None or abs(got[0] - want[0]) > 2 or abs(got[1] - want[1]) > 2:
        print('  !! erwartet', want); bad += 1
print('Alles wie berechnet' if not bad else f'{bad} Abweichung(en)')
sys.exit(1 if bad else 0)
