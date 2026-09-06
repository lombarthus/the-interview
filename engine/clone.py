"""Aus einer beliebigen Aufnahme eine Klonstimme bauen — oder eine bestehende neu schneiden.

Erzeugt in <voices>/<Name>/:
  original.wav        ganze Aufnahme, 24 kHz mono
  audio.wav           OmniVoice-Referenzclip ≈ 6 s, geschnitten an einer WORTGRENZE in einer Pause
  ref.txt             Transkript genau dieses Clips
  lang.txt            Sprache
  audio.<lang>.wav    Pocket-TTS-Vorlage ≈ 12 s ab derselben Stelle (ebenfalls Wortgrenze)
  words.json          Wort-Zeitstempel der ganzen Aufnahme (Cache für Neuschnitte)
  clip.json           wo der Clip in der Aufnahme liegt

Warum Wortgrenze: ein hörbares Wort ohne Text im Clip spricht OmniVoice vor jedem Satz mit; ein
Textwort ohne Audio verschluckt Satzanfänge. Audio und Text enden an derselben Stelle in einer Pause."""
from __future__ import annotations

import difflib
import json
import os
import re
from pathlib import Path

import asr
from common import POCKET_LANGS, VOICES_DIR, ffmpeg, log

MAX_SECONDS = 6.0
SLACK = 0.6
PAD = 0.12
GAP = 0.10
MAX_STEP_BACK = 2
LEAD_IN = 0.15
SCAN_SECONDS = 14.0
POCKET_SECONDS = 12.0
WORD_RE = re.compile(r"\S+")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def norm(tok: str) -> str:
    return re.sub(r"[^\w]", "", tok.lower(), flags=re.UNICODE)


def duration_of(p: Path) -> float:
    import soundfile as sf
    return float(sf.info(str(p)).duration)


def pick_end(heard, start: float, mapping, n_text, seconds: float = MAX_SECONDS) -> int:
    limit = start + seconds + SLACK
    if mapping is None:
        cands = [j for j, (_, _, e) in enumerate(heard) if e <= limit]
    else:
        cands = [mapping[i] for i in range(n_text or 0) if i in mapping and heard[mapping[i]][2] <= limit]
    if not cands:
        return -1

    def gap_ok(idx: int) -> bool:
        return idx + 1 >= len(heard) or heard[idx + 1][1] - heard[idx][2] >= GAP

    j0 = max(cands)
    j = j0
    for _ in range(MAX_STEP_BACK + 1):
        if gap_ok(j):
            return j
        smaller = [c for c in cands if c < j]
        if not smaller:
            break
        j = max(smaller)
    return j0


def cut_after(heard, idx: int, total: float) -> float:
    end_k = heard[idx][2]
    cut = end_k + PAD
    if idx + 1 < len(heard) and heard[idx + 1][1] < cut:
        cut = max(end_k + 0.03, heard[idx + 1][1] - 0.02)
    return min(cut, total)


def write_pocket_template(vdir: Path, original: Path, lang: str, start: float, omni_cut: float, omni_text: str, heard, seconds: float, total: float) -> dict | None:
    if lang not in POCKET_LANGS:
        return None
    jp = pick_end(heard, start, None, None, seconds=seconds)
    cut_p = cut_after(heard, jp, total) if jp >= 0 else omni_cut
    if cut_p <= omni_cut + 0.05:
        cut_p, text_p, n_words = omni_cut, omni_text, len(WORD_RE.findall(omni_text))
    else:
        text_p, n_words = " ".join(w for (w, _, _) in heard[: jp + 1]), jp + 1
    tmp = vdir / f"audio.{lang}.tmp.wav"
    ffmpeg(["-i", str(original), "-ss", f"{start:.3f}", "-t", f"{cut_p - start:.3f}", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(tmp)])
    os.replace(tmp, vdir / f"audio.{lang}.wav")
    (vdir / f"audio.{lang}.txt").write_text(f"# Pocket-TTS-Vorlage {start:.2f}-{cut_p:.2f} s aus original.wav\n\n{text_p}\n", encoding="utf-8")
    for old in vdir.glob("audio.??.wav"):
        if old.name != f"audio.{lang}.wav":
            try:
                old.unlink()
                old.with_suffix(".txt").unlink(missing_ok=True)
            except OSError:
                pass
    return {"file": f"audio.{lang}.wav", "seconds": round(cut_p - start, 2), "start": round(start, 2), "end": round(cut_p, 2), "words": n_words}


def full_words(vdir: Path, original: Path, lang: str | None, log_fn=log) -> list[tuple[str, float, float]]:
    """Wort-Zeitstempel der ganzen Aufnahme, gecacht in words.json."""
    wf = vdir / "words.json"
    if wf.is_file():
        try:
            j = json.loads(wf.read_text(encoding="utf-8"))
            return [(str(x["w"]), float(x["s"]), float(x["e"])) for x in j.get("words", []) if x.get("w")]
        except Exception:
            pass
    total = duration_of(original)
    log_fn(f"Höre die ganze Aufnahme ab ({total:.0f} s) …")
    heard = asr.words(str(original), lang, 0.0, None)
    wf.write_text(json.dumps({"originalSeconds": round(total, 2), "words": [{"w": w, "s": round(s, 2), "e": round(e, 2)} for (w, s, e) in heard]}, ensure_ascii=False), encoding="utf-8")
    return heard


def build(name: str, *, input_file: str | None = None, language: str = "auto", text: str = "", recut: bool = False,
          offset: float | None = None, start: float | None = None, end: float | None = None, log_fn=log) -> dict:
    if not NAME_RE.match(name):
        raise ValueError("Name: nur Buchstaben, Ziffern, _ und -, max. 40 Zeichen")
    vdir = VOICES_DIR / name
    vdir.mkdir(parents=True, exist_ok=True)
    original = vdir / "original.wav"
    if recut:
        if not original.is_file():
            raise FileNotFoundError("kein original.wav — Neuschnitt nicht möglich")
    else:
        if not input_file or not Path(input_file).is_file():
            raise FileNotFoundError("Eingabedatei fehlt")
        log_fn("Konvertiere Aufnahme nach 24 kHz mono …")
        tmp = vdir / "original.tmp.wav"
        ffmpeg(["-i", input_file, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(tmp)])
        os.replace(tmp, original)
        (vdir / "words.json").unlink(missing_ok=True)
    total = duration_of(original)
    log_fn(f"Aufnahme: {total:.1f} s")
    if total < 3.0:
        raise ValueError("Aufnahme ist kürzer als drei Sekunden")

    meta_file = vdir / "clip.json"
    meta = {}
    if meta_file.is_file():
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        except Exception:
            meta = {}
    lang_code = (language or "auto").strip().lower()
    if lang_code == "auto":
        lang_code = (meta.get("lang") if recut else None) or asr.detect_language(str(original))
    log_fn(f"Sprache: {lang_code}")

    heard_all = full_words(vdir, original, lang_code, log_fn)
    if not heard_all:
        raise RuntimeError("Whisper hat kein Wort erkannt")

    manual = start is not None or end is not None
    if manual:
        m_start = max(0.0, float(start or 0))
        m_end = min(total, float(end or (m_start + MAX_SECONDS)))
        if m_end - m_start < 1.0:
            raise ValueError("Auswahl ist kürzer als eine Sekunde")
        inside = [i for i, (_, s, e) in enumerate(heard_all) if s >= m_start - 0.05 and e <= m_end + 0.05]
        if not inside:
            raise ValueError("In der Auswahl liegt kein ganzes Wort")
        prev_end = heard_all[inside[0] - 1][2] if inside[0] > 0 else None
        heard = heard_all[inside[0]:]
        scan_offset = m_start
    else:
        if offset is not None:
            scan_offset = max(0.0, float(offset))
        elif recut:
            scan_offset = float(meta.get("scanOffset", 0.0) or 0.0)
        else:
            scan_offset = 0.0
        if scan_offset + MAX_SECONDS + 1.0 > total:
            scan_offset = 0.0
        heard = [w for w in heard_all if w[1] >= scan_offset]
        prev_end = None
        if not heard:
            raise RuntimeError(f"Ab Sekunde {scan_offset:.0f} kein Wort gehört")
    clip_start = max(0.0, heard[0][1] - LEAD_IN)
    if prev_end is not None and clip_start < prev_end + 0.02:
        clip_start = min(heard[0][1], prev_end + 0.02)

    human = WORD_RE.findall(text) if text.strip() else []
    mapping = None
    if human:
        a = [norm(w) for w in human]
        b = [norm(w) for (w, _, _) in heard]
        mapping = {}
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
            if tag == "equal" or (tag == "replace" and (i2 - i1) == (j2 - j1)):
                for k in range(i2 - i1):
                    mapping[i1 + k] = j1 + k
        if len(mapping) < max(1, len(human)) * 0.5:
            raise ValueError("Das Transkript passt nicht zu dem, was Whisper hört — bitte gegenhören")

    if manual:
        j = max((i for i, (_, _, e) in enumerate(heard) if e <= m_end + 0.05), default=-1)
    else:
        j = pick_end(heard, clip_start, mapping, len(human) if human else None)
    if j < 0:
        raise RuntimeError("kein passendes Wortende im 6-s-Fenster")
    cut = cut_after(heard, j, total)
    if human:
        k = max(i for i, jj in mapping.items() if jj <= j)
        clip_text = " ".join(human[: k + 1])
    else:
        clip_text = " ".join(w for (w, _, _) in heard[: j + 1])

    log_fn(f"Clip {clip_start:.2f}–{cut:.2f} s ({cut - clip_start:.2f} s), {j + 1} Wörter")
    tmp = vdir / "audio.tmp.wav"
    ffmpeg(["-i", str(original), "-ss", f"{clip_start:.3f}", "-t", f"{cut - clip_start:.3f}", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(tmp)])
    os.replace(tmp, vdir / "audio.wav")
    (vdir / "ref.txt").write_text(clip_text + "\n", encoding="utf-8")
    (vdir / "lang.txt").write_text(lang_code + "\n", encoding="utf-8")
    pocket_seconds = max(POCKET_SECONDS, (m_end - heard[0][1]) if manual else 0)
    pocket = write_pocket_template(vdir, original, lang_code, clip_start, cut, clip_text, heard, pocket_seconds, total)
    if pocket:
        log_fn(f"Pocket-Vorlage {pocket['file']}: {pocket['seconds']} s")
    attempt = int(meta.get("attempt", 0) or 0) + 1
    meta_file.write_text(json.dumps({"scanOffset": round(scan_offset, 2), "start": round(clip_start, 2), "end": round(cut, 2), "attempt": attempt, "lang": lang_code,
                                     "source": "editor" if manual else ("text" if human else "whisper"), "pocket": pocket}, indent=2), encoding="utf-8")
    try:
        import pocket as pocket_engine
        pocket_engine.forget_voice(name)
    except Exception:
        pass
    return {"ok": True, "name": name, "language": lang_code, "text": clip_text, "clipSeconds": round(cut - clip_start, 2), "start": round(clip_start, 2), "end": round(cut, 2),
            "originalSeconds": round(total, 1), "attempt": attempt, "pocket": pocket, "heard": " ".join(w for (w, _, _) in heard[: j + 1])}
