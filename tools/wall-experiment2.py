#!/usr/bin/env python3
# Experiment 2 (nicht Teil des Produkts): Versteht mpv „video-crop“ (ohne Filter, also ohne Kopie der Bilder) auch Prozentwerte?
import json, os, socket, subprocess, time, shutil
D = '/tmp/wall2'; shutil.rmtree(D, ignore_errors=True); os.makedirs(D)
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25:duration=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', f'{D}/hd.mp4'], check=True)
sock = f'{D}/sock'
p = subprocess.Popen(['mpv', '--idle=yes', '--force-window=no', '--vo=null', '--ao=null', '--no-audio', '--msg-level=all=warn', f'--input-ipc-server={sock}', '--keep-open=yes'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(50):
    if os.path.exists(sock): break
    time.sleep(0.1)
s = socket.socket(socket.AF_UNIX); s.connect(sock); s.settimeout(1.0)
buf = b''
def cmd(*a):
    global buf
    s.sendall((json.dumps({'command': list(a)}) + '\n').encode())
    t0 = time.time()
    while time.time() - t0 < 1.0:
        try: buf += s.recv(65536)
        except Exception: break
        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            try: j = json.loads(line)
            except Exception: continue
            if 'error' in j: return j
    return None
print('version', cmd('get_property', 'mpv-version'))
cmd('loadfile', f'{D}/hd.mp4', 'replace'); time.sleep(1.0)
for v in ['960x540+0+0', '50%x100%+0+0', '33.3333%x100%+33.3333%+0', '33.33%x56.25%+33.33%+21.875%', '960x540+960+540']:
    r = cmd('set_property', 'video-crop', v)
    g = cmd('get_property', 'video-crop')
    d = cmd('get_property', 'video-out-params/dw')
    print(f'{v:20s} set={r and r.get("error")}  get={g and g.get("data")}  dw={d and d.get("data")}')
cmd('quit'); p.wait(timeout=5)
