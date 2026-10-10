#!/usr/bin/env python3
"""Dev-only: compose the executive demo video from recorded shots, cards and caption overlays.

Usage: python3 scripts/dev/video/compose.py <workDir> <outDir>
  workDir: output of exec-video.mts + render-cards.mjs (one folder per segment with frames.ffconcat, overlays/*.png)
Produces: TenderFlow-Executive-Demo.mp4 (with a synthetic English voice-over), TenderFlow-Executive-Demo.srt, narration-script.md
Needs: pip install kokoro-onnx soundfile, and the Kokoro model files (kokoro-v1.0.onnx, voices-v1.0.bin) in TF_TTS_DIR.
"""
import json, os, subprocess, sys

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

# ---- voice-over (Kokoro TTS, local model files; see README in this folder) ----
VOICE = os.environ.get('TF_VOICE', 'af_heart')
TTS_DIR = os.environ.get('TF_TTS_DIR', '/tmp/claude-0/tts')
SAY = [('TenderFlow', 'Tender Flow'), ('watsonx', 'watson-x'), ('FileNet', 'File Net'), ('IBM', 'I B M'), ('OpenShift', 'Open Shift'),
       ('TechZone', 'Tech Zone'), ('e-tendering', 'e-tendering'), ('KBM', 'K B M')]
def speakable(text):
    for a, b in SAY: text = text.replace(a, b)
    return text
_tts = None
def voice(seg):
    import hashlib, soundfile as sf
    global _tts
    text = speakable(seg['say'])
    key = hashlib.sha1(f"{VOICE}|{text}".encode()).hexdigest()[:12]
    wav = os.path.join(seg_dir, f"vo-{seg['id']}-{key}.wav")
    if not os.path.exists(wav):
        if _tts is None:
            from kokoro_onnx import Kokoro
            _tts = Kokoro(os.path.join(TTS_DIR, 'kokoro-v1.0.onnx'), os.path.join(TTS_DIR, 'voices-v1.0.bin'))
        samples, sr = _tts.create(text, voice=VOICE, speed=1.0, lang='en-us' if VOICE[0] == 'a' else 'en-gb')
        sf.write(wav, samples, sr)
    info = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], capture_output=True, text=True)
    return wav, float(info.stdout.strip())

LEAD, TAIL = 0.45, 0.75
timeline = []
t = 0.0
for seg in board['segments']:
    src = os.path.join(work, seg['id'], 'frames.ffconcat')
    if not os.path.exists(src):
        print('missing segment, skipped:', seg['id']); continue
    vdur = round(ffconcat_duration(src), 2)
    if seg.get('card'): vdur = min(vdur, seg['seconds'])
    wav, adur = voice(seg)
    dur = round(max(vdur, LEAD + adur + TAIL), 2)
    hold = max(0.0, dur - vdur)
    outp = os.path.join(seg_dir, seg['id'] + '.mp4')
    base = (f"[0:v]fps=30,scale=1920:1080:flags=lanczos,unsharp=5:5:0.35:5:5:0,setsar=1,trim=duration={vdur},"
            f"tpad=stop_mode=clone:stop_duration={hold + 0.1:.2f},trim=duration={dur},format=rgba[b]")
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', src, '-i', wav]
    if seg.get('shot'):
        cmd += ['-loop', '1', '-t', str(dur), '-i', os.path.join(work, 'overlays', seg['id'] + '.png')]
        fc = (base + f";[2:v]format=rgba,fade=t=in:st=0.45:d=0.6:alpha=1[o];[b][o]overlay=0:0:format=auto[m];"
              f"[m]fade=t=in:st=0:d={FADE},fade=t=out:st={dur - FADE:.2f}:d={FADE},format=yuv420p[v]")
    else:
        fc = base + f";[b]fade=t=in:st=0:d={FADE},fade=t=out:st={dur - FADE:.2f}:d={FADE},format=yuv420p[v]"
    lead_ms = int(LEAD * 1000)
    fc += f";[1:a]aresample=48000,aformat=channel_layouts=stereo,adelay={lead_ms}|{lead_ms},apad,atrim=duration={dur}[a]"
    cmd += ['-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', str(dur), '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', outp]
    run(cmd)
    timeline.append({**seg, 'start': t, 'end': t + dur, 'file': outp, 'voice': (t + LEAD, t + LEAD + adur)})
    print(f"{seg['id']:<20} {dur:6.2f}s (video {vdur:5.2f}, voice {adur:5.2f}) @ {t:7.2f}")
    t += dur

total = t
lst = os.path.join(seg_dir, 'list.txt')
open(lst, 'w').write(''.join(f"file '{s['file']}'\n" for s in timeline))
joined = os.path.join(seg_dir, 'joined.mp4')
run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', joined])
final = os.path.join(out, 'TenderFlow-Executive-Demo.mp4')
# loudness-normalise the voice for clear playback on laptops and meeting-room speakers
run(['ffmpeg', '-y', '-loglevel', 'error', '-i', joined, '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '160k',
     '-movflags', '+faststart', '-metadata', f"title={board['title']}", final])

# ---- SRT (narration lines, timed to the segments) and narration script ----
def ts(x):
    h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
    return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"
with open(os.path.join(out, 'TenderFlow-Executive-Demo.srt'), 'w', encoding='utf-8') as f:
    for i, s in enumerate(timeline, 1):
        f.write(f"{i}\n{ts(s['voice'][0])} --> {ts(s['voice'][1] + 0.2)}\n{s['say']}\n\n")
with open(os.path.join(out, 'narration-script.md'), 'w', encoding='utf-8') as f:
    f.write(f"# {board['title']} — narration script\n\n")
    f.write(f"Length {int(total // 60)}:{int(total % 60):02d}. The video carries this narration as a synthetic voice-over (Kokoro TTS); to record your own voice, read each line at its time. "
            "All organisations, people and figures shown are fictitious demo data. The FileNet scenes were recorded against the "
            "FileNet Content Services API simulator used in the test suite; validation on the IBM TechZone FileNet environment is pending.\n\n")
    f.write("| Time | Scene | Narration |\n|---|---|---|\n")
    for s in timeline:
        scene = s.get('title') or s['card'].upper() if s.get('card') else s.get('title')
        label = s.get('title') or {'title': 'Title', 'challenge': 'The challenge', 'solution': 'The solution', 'wxo': 'watsonx Orchestrate agents',
                                   'deploy': 'Deployment and security', 'close': 'Closing'}.get(s.get('card'), 'Chapter card')
        f.write(f"| {ts(s['start'])[3:8]} | {label} | {s['say']} |\n")
print(f'total {total:.1f}s → {final}')
