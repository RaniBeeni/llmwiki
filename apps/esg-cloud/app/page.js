"use client";

import { useEffect, useState } from "react";

const samples = [
  "GOV-1.1",
  "GOV-1.2",
  "KSSB에서 경영진의 역할은 무엇을 공시해야 하나?",
];

export default function Home() {
  const [status, setStatus] = useState(null);
  const [question, setQuestion] = useState("GOV-1.2");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, []);

  async function ask(q = question) {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "질의 실패");
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <header className="hero">
        <div>
          <span className="eyebrow">CORP-ESG-001 · SHADOW KNOWLEDGE</span>
          <h1>ESG AI Knowledge</h1>
          <p>
            공식 원문·Requirement DB·Notion 판단을 대체하지 않는
            Cloud-first Shadow Wiki Pilot.
          </p>
        </div>
        <div className="statusCard">
          <span className="badge">SHADOW</span>
          <strong>{status?.pages ?? "—"} pages</strong>
          <span>{status?.sources ?? "—"} sources · {status?.open_contradictions ?? "—"} conflicts</span>
        </div>
      </header>

      <section className="panel">
        <label htmlFor="q">질문</label>
        <div className="askRow">
          <input
            id="q"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && ask()}
            placeholder="예: GOV-1.2 또는 KSSB 거버넌스 질문"
          />
          <button onClick={() => ask()} disabled={loading}>
            {loading ? "근거 찾는 중…" : "질문하기"}
          </button>
        </div>
        <div className="samples">
          {samples.map((s) => (
            <button key={s} className="chip" onClick={() => { setQuestion(s); ask(s); }}>
              {s}
            </button>
          ))}
        </div>
      </section>

      {error && <section className="panel error">{error}</section>}

      {result && (
        <>
          <section className="panel answer">
            <div className="sectionTitle">
              <h2>답변</h2>
              <span className="badge">{result.insufficient ? "INSUFFICIENT" : "SHADOW"}</span>
            </div>
            <p className="answerText">{result.answer}</p>
          </section>

          <section className="panel">
            <h2>근거</h2>
            <div className="evidenceGrid">
              {result.evidence.length === 0 && <p>표시할 근거가 없습니다.</p>}
              {result.evidence.map((e, i) => (
                <article key={`${e.page_id}-${i}`} className="evidence">
                  <strong>{e.page_id}</strong>
                  <span>{e.page_title}</span>
                  <code>{e.source_id}</code>
                  <span>
                    PDF p.{e.locator?.pdf_page ?? "?"}
                    {e.locator?.paragraph ? ` · ${e.locator.paragraph}` : ""}
                  </span>
                  <a href={e.source_locator} target="_blank" rel="noreferrer">
                    Google Drive 원문
                  </a>
                </article>
              ))}
            </div>
          </section>
        </>
      )}

      <footer>
        Authority: 공식 원문 → External Requirement Backbone → Notion 공식 SSoT → 승인된 회사정보 → Shadow Wiki
      </footer>
    </main>
  );
}
