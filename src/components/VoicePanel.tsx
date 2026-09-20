import { useState, type FormEvent } from "react";
import { EXAMPLE_PHRASES } from "../voice/grammar";
import type { VoiceApi } from "../voice/useVoice";
import { MicIcon, MicOffIcon } from "./icons";

/**
 * The voice rail panel: a mic toggle, what was just heard, and a typed
 * fallback that runs the identical pipeline.
 *
 * The text box is not a debug affordance — it is the whole feature for anyone
 * in a browser without the Web Speech API (Firefox), in a shared room, or with
 * the mic in use. It is also what the e2e suite drives.
 */
export function VoicePanel({ voice }: { voice: VoiceApi }) {
  const [draft, setDraft] = useState("");
  const { status, listening, interim, log, thinking, supported } = voice;
  const last = log[0];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (text === "") return;
    setDraft("");
    void voice.run(text);
  };

  return (
    <section className="voice" aria-label="Voice commands">
      <div className="voice__head">
        <span>Say it</span>
        {listening && (
          <button type="button" className="voice__disable" onClick={voice.stop}>
            stop
          </button>
        )}
      </div>

      {supported ? (
        <button
          type="button"
          className={`voice__mic ${listening ? "voice__mic--live" : ""}`}
          onClick={voice.toggle}
          aria-pressed={listening}
          data-testid="voice-mic"
        >
          {listening ? <MicIcon /> : <MicOffIcon />}
          <span>{listening ? "Listening…" : "Start listening"}</span>
          {listening && <span className="voice__pulse" aria-hidden="true" />}
        </button>
      ) : (
        <p className="voice__note">
          This browser has no speech recognition. Type commands below — they work the same.
        </p>
      )}

      {status === "denied" && (
        <p className="voice__note voice__note--warn">
          Microphone blocked. Allow it in the address bar, or type commands below.
        </p>
      )}

      <div className="voice__live" aria-live="polite">
        {interim !== "" ? (
          <span className="voice__interim">{interim}</span>
        ) : last ? (
          <span className={`voice__last ${last.ok ? "" : "voice__last--warn"}`}>
            <em>{last.text}</em>
            <span className="voice__detail">{thinking ? "thinking…" : last.detail}</span>
          </span>
        ) : (
          <span className="voice__hint">e.g. “add a box called Signal”</span>
        )}
      </div>

      <form className="voice__form" onSubmit={submit}>
        <input
          className="voice__input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a command…"
          aria-label="Type a command"
          data-testid="voice-input"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="voice__run" disabled={draft.trim() === ""}>
          Run
        </button>
      </form>

      <div className="voice__chips">
        {EXAMPLE_PHRASES.slice(0, 3).map((phrase) => (
          <button
            key={phrase}
            type="button"
            className="voice__chip"
            onClick={() => void voice.run(phrase)}
            title={`Run “${phrase}”`}
          >
            {phrase}
          </button>
        ))}
      </div>
    </section>
  );
}
