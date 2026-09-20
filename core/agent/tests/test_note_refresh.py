"""A segment the speaker is still finishing: the report must read its LAST text, never its first."""
import json
from worker.meeting import serve_meeting


class Stream:
    def __init__(self, entries):
        self.entries, self.added, self.kv = entries, [], {}
    def xread(self, keys, count=50, block=0):
        if not self.entries:
            return []
        return [("tc", [self.entries.pop(0)])]
    def xadd(self, key, fields):
        self.added.append((key, fields))
    def set(self, *a, **k): pass
    def get(self, *a, **k): return None


def entry(eid, segments, **extra):
    return (eid, {"payload": json.dumps({"segments": segments, **extra})})


def run(entries, *, doc_turn=None):
    stream = Stream(list(entries))
    serve_meeting(stream, transcript_stream="tc", out_topic="out", proc_stream="proc",
                  card_turn=lambda segs: iter(()), enabled=False, doc_turn=doc_turn, idle_ms=1)
    notes = [json.loads(f["note"]) for key, f in stream.added if key == "proc" and "note" in f]
    return stream, notes


def test_a_refined_segment_republishes_its_final_text():
    _, notes = run([
        entry("1-0", [{"segment_id": "s1", "speaker": "Volkan", "text": "Genişletme noktasında ucu açık bıraktık.", "start": 1.0}]),
        entry("2-0", [{"segment_id": "s1", "speaker": "Volkan",
                       "text": "Genişletme noktasında ucu açık bıraktık, test ekibinden geri bildirim alırız.", "start": 1.0}]),
    ])
    assert [n["text"] for n in notes] == [
        "Genişletme noktasında ucu açık bıraktık.",
        "Genişletme noktasında ucu açık bıraktık, test ekibinden geri bildirim alırız.",
    ]
    assert {n["id"] for n in notes} == {"s1"}  # one line, updated — not two lines


def test_an_unchanged_draft_publishes_nothing_new():
    _, notes = run([
        entry("1-0", [{"segment_id": "s1", "speaker": "Volkan", "text": "Aynı cümle.", "start": 1.0}]),
        entry("2-0", [{"segment_id": "s1", "speaker": "Volkan", "text": "Aynı cümle.", "start": 1.0}]),
    ])
    assert len(notes) == 1


def test_the_report_is_authored_on_the_final_text():
    seen = {}
    def doc_turn(cards, notes):
        seen["notes"] = [n["text"] for n in notes]
        return iter(())
    run([
        entry("1-0", [{"segment_id": "s1", "speaker": "Volkan", "text": "E-Dönüşüm bunun genel ismi.", "start": 1.0}]),
        entry("2-0", [{"segment_id": "s1", "speaker": "Volkan",
                       "text": "E-Dönüşüm bunun genel ismi. Yani E-İşler ibaresini kullanmayalım hiç.", "start": 1.0}]),
        entry("3-0", [], type="session_end"),
    ], doc_turn=doc_turn)
    assert seen["notes"] == ["E-Dönüşüm bunun genel ismi. Yani E-İşler ibaresini kullanmayalım hiç."]
