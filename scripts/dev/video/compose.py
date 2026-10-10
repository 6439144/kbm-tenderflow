#!/usr/bin/env python3
"""Dev-only: compose the executive demo video from recorded shots, cards and caption overlays.

Usage: python3 scripts/dev/video/compose.py <workDir> <outDir>
  workDir: output of exec-video.mts + render-cards.mjs (one folder per segment with frames.ffconcat, overlays/*.png)
Produces: TenderFlow-Executive-Demo.mp4, TenderFlow-Executive-Demo.srt, narration-script.md
"""
import json, os, subprocess, sys, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
work, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
seg_dir = os.path.join(work, '_segments'); os.makedirs(seg_dir, exist_ok=True)
board = json.load(open(os.path.join(HERE, 'storyboard.json')))
FADE = 0.35

def ffconcat_duration(path):
    total = 0.0
    for line in open(path):
        if line.startswith('duration '):
            total += float(line.split()[1])
    return total

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-3000:]); raise SystemExit(f'ffmpeg failed: {" ".join(cmd[:6])}…')

timeline = []
t = 0.0
for seg in board['segments']:
    src = os.path.join(work, seg['id'], 'frames.ffconcat')
    if not os.path.exists(src):
        print('missing segment, skipped:', seg['id']); continue
    dur = round(ffconcat_duration(src), 2)
    if seg.get('card'): dur = min(dur, seg['seconds'])
    outp = os.path.join(seg_dir, seg['id'] + '.mp4')
    base = f"[0:v]fps=30,scale=1920:1080:flags=lanczos,unsharp=5:5:0.35:5:5:0,setsar=1,format=rgba,trim=duration={dur}[b]"
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', src]
    if seg.get('shot'):
        cmd += ['-loop', '1', '-t', str(dur), '-i', os.path.join(work, 'overlays', seg['id'] + '.png')]
        fc = (base + f";[1:v]format=rgba,fade=t=in:st=0.45:d=0.6:alpha=1[o];[b][o]overlay=0:0:format=auto[m];"
              f"[m]fade=t=in:st=0:d={FADE},fade=t=out:st={dur - FADE:.2f}:d={FADE},format=yuv420p[v]")
    else:
        fc = base + f";[b]fade=t=in:st=0:d={FADE},fade=t=out:st={dur - FADE:.2f}:d={FADE},format=yuv420p[v]"
    cmd += ['-filter_complex', fc, '-map', '[v]', '-t', str(dur), '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outp]
    run(cmd)
    timeline.append({**seg, 'start': t, 'end': t + dur, 'file': outp})
    print(f"{seg['id']:<20} {dur:6.2f}s  @ {t:7.2f}")
    t += dur

total = t
# ---- concat video ----
lst = os.path.join(seg_dir, 'list.txt')
open(lst, 'w').write(''.join(f"file '{s['file']}'\n" for s in timeline))
silent = os.path.join(seg_dir, 'video.mp4')
run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', silent])

# ---- soft ambient music bed (synthesised; no third-party audio) ----
SR = 48000
n = int((total + 0.5) * SR)
tt = np.arange(n) / SR
chords = [  # D – Bm – G – A (gentle, major)
    [146.83, 220.00, 293.66, 369.99, 440.00],
    [123.47, 185.00, 246.94, 293.66, 369.99],
    [98.00, 196.00, 246.94, 293.66, 392.00],
    [110.00, 164.81, 220.00, 277.18, 329.63],
]
CH = 8.0  # seconds per chord
audio = np.zeros(n)
k = 0
while k * CH < total + CH:
    freqs = chords[k % 4]
    s0 = k * CH - 1.5
    a, b = max(0, int(s0 * SR)), min(n, int((s0 + CH + 3.0) * SR))
    if a >= n: break
    seg_t = tt[a:b] - s0
    env = np.clip(seg_t / 2.0, 0, 1) * np.clip((CH + 3.0 - seg_t) / 2.5, 0, 1)
    env = env ** 1.5
    tone = np.zeros(b - a)
    for i, f in enumerate(freqs):
        amp = 1.0 / (1 + i * 0.6)
        for det in (-0.0018, 0.0, 0.0021):
            tone += amp * np.sin(2 * np.pi * f * (1 + det) * tt[a:b] + i)
        tone += 0.12 * amp * np.sin(2 * np.pi * 2 * f * tt[a:b])
    trem = 0.85 + 0.15 * np.sin(2 * np.pi * 0.11 * tt[a:b] + k)
    audio[a:b] += tone * env * trem
    k += 1
# simple feedback delay for space
for d, g in ((0.29, 0.28), (0.53, 0.18), (0.97, 0.10)):
    sh = int(d * SR); audio[sh:] += g * audio[:-sh]
audio /= np.max(np.abs(audio)) + 1e-9
audio *= 10 ** (-17 / 20)  # quiet bed
fade_in, fade_out = int(2.5 * SR), int(4.0 * SR)
audio[:fade_in] *= np.linspace(0, 1, fade_in)
audio[-fade_out:] *= np.linspace(1, 0, fade_out)
wav = os.path.join(seg_dir, 'bed.wav')
with wave.open(wav, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    st = np.stack([audio, np.roll(audio, int(0.012 * SR))], axis=1)
    w.writeframes((st * 32767).astype('<i2').tobytes())

final = os.path.join(out, 'TenderFlow-Executive-Demo.mp4')
run(['ffmpeg', '-y', '-loglevel', 'error', '-i', silent, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
     '-shortest', '-movflags', '+faststart', '-metadata', f"title={board['title']}", final])

# ---- SRT (narration lines, timed to the segments) and narration script ----
def ts(x):
    h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
    return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"
with open(os.path.join(out, 'TenderFlow-Executive-Demo.srt'), 'w', encoding='utf-8') as f:
    for i, s in enumerate(timeline, 1):
        f.write(f"{i}\n{ts(s['start'] + 0.3)} --> {ts(s['end'] - 0.2)}\n{s['say']}\n\n")
with open(os.path.join(out, 'narration-script.md'), 'w', encoding='utf-8') as f:
    f.write(f"# {board['title']} — narration script\n\n")
    f.write(f"Length {int(total // 60)}:{int(total % 60):02d}. Read at a calm pace; each line fits its scene. "
            "All organisations, people and figures shown are fictitious demo data. The FileNet scenes were recorded against the "
            "FileNet Content Services API simulator used in the test suite; validation on the IBM TechZone FileNet environment is pending.\n\n")
    f.write("| Time | Scene | Narration |\n|---|---|---|\n")
    for s in timeline:
        scene = s.get('title') or s['card'].upper() if s.get('card') else s.get('title')
        label = s.get('title') or {'title': 'Title', 'challenge': 'The challenge', 'solution': 'The solution', 'wxo': 'watsonx Orchestrate agents',
                                   'deploy': 'Deployment and security', 'close': 'Closing'}.get(s.get('card'), 'Chapter card')
        f.write(f"| {ts(s['start'])[3:8]} | {label} | {s['say']} |\n")
print(f'total {total:.1f}s → {final}')
