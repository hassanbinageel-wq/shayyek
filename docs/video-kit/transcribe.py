import sys, json
from faster_whisper import WhisperModel
import subprocess, numpy as np
m = WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
raw = subprocess.run(["ffmpeg","-loglevel","error","-i",sys.argv[2],"-f","s16le","-ac","1","-ar","16000","-"],capture_output=True).stdout
audio = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
segs, info = m.transcribe(audio, language="ar", word_timestamps=True, beam_size=5,
    initial_prompt="تبي تربط حساب انستقرام؟ أربع خطوات بس. شيّك. الإعدادات والنشاط. نوع الحساب والأدوات. تبديل إلى حساب احترافي. ميتا. السماح.")
out = []
for s in segs:
    print(f"[{s.start:6.2f}-{s.end:6.2f}] {s.text}")
    for w in s.words: out.append([round(w.start, 2), round(w.end, 2), w.word])
json.dump(out, open(sys.argv[3], "w"), ensure_ascii=False)
