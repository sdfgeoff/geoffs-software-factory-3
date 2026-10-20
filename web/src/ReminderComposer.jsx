import React, { useState, useRef } from "react";
import { Bell, Clock, CalendarDays, Check } from "lucide-react";
import {
  customReminderTime,
  localDateValue,
  reminderTimeLabel,
  reminderRequest,
} from "./reminder-time.mjs";

export default function ReminderComposer({
  Dialog,
  onClose,
  onCreate,
  onCreated,
}) {
  const [message, setMessage] = useState("");
  const [choice, setChoice] = useState("hour");
  const [target, setTarget] = useState(() => new Date(Date.now() + 3600000));
  const [day, setDay] = useState(() => localDateValue(new Date()));
  const [time, setTime] = useState("09:00");
  const [repeat, setRepeat] = useState(false);
  const [amount, setAmount] = useState("24");
  const [unit, setUnit] = useState("hour");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const due = choice === "custom" ? customReminderTime(day, time) : target;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  function choose(value) {
    setChoice(value);
    setError("");
    const next = new Date();
    if (value === "tomorrow") {
      next.setDate(next.getDate() + 1);
      next.setHours(9, 0, 0, 0);
    } else
      next.setTime(next.getTime() + (value === "quarter" ? 900000 : 3600000));
    setTarget(next);
  }
  return (
    <Dialog
      title="New reminder"
      initialFocus="textarea"
      onClose={() => {
        if (!submitting.current) onClose();
      }}
    >
      <form
        className="reminder-composer"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          let body;
          try {
            body = reminderRequest(message, due, repeat, amount, unit);
          } catch (e) {
            setError(e.message);
            return;
          }
          submitting.current = true;
          setBusy(true);
          setError("");
          try {
            const saved = await onCreate(body);
            onCreated(saved);
          } catch (e) {
            setError(e.message);
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label htmlFor="reminder-message">
            What do you want to remember?
          </label>
          <textarea
            id="reminder-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={50000}
            rows={3}
            placeholder="Check the build results…"
            required
          />
          <div className="reminder-label" id="reminder-when">
            When should we remind you?
          </div>
          <div
            className="reminder-presets"
            role="group"
            aria-labelledby="reminder-when"
          >
            {[
              ["quarter", "In 15 minutes", Clock],
              ["hour", "In 1 hour", Clock],
              ["tomorrow", "Tomorrow, 9am", Bell],
              ["custom", "Choose date & time", CalendarDays],
            ].map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                className={`reminder-preset ${choice === value ? "selected" : ""}`}
                aria-pressed={choice === value}
                onClick={() => choose(value)}
              >
                <Icon size={16} />
                <span>{label}</span>
                {choice === value && <Check size={14} />}
              </button>
            ))}
          </div>
          {choice === "custom" && (
            <div className="reminder-custom">
              <label>
                Date
                <input
                  type="date"
                  value={day}
                  onChange={(e) => {
                    setDay(e.target.value);
                    setError("");
                  }}
                  required
                />
              </label>
              <label>
                Time
                <input
                  type="time"
                  value={time}
                  onChange={(e) => {
                    setTime(e.target.value);
                    setError("");
                  }}
                  required
                />
              </label>
            </div>
          )}
          <p className="reminder-zone">
            Your timezone: {timezone}. The preview shows the UTC offset.
            {choice === "custom" &&
              " If the clocks repeat an hour, the first occurrence is used."}
          </p>
          <label className="reminder-repeat-toggle">
            <input
              type="checkbox"
              checked={repeat}
              onChange={(e) => setRepeat(e.target.checked)}
            />
            Repeat this reminder <span>Optional</span>
          </label>
          {repeat && (
            <div className="reminder-repeat-settings">
              <div className="reminder-custom">
                <label>
                  Repeat every
                  <input
                    type="number"
                    min="1"
                    max="525600"
                    step="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Interval unit
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  >
                    <option value="minute">minutes</option>
                    <option value="hour">hours</option>
                    <option value="day">days (24 hours)</option>
                    <option value="week">weeks (168 hours)</option>
                  </select>
                </label>
              </div>
              <p>
                Repeats after a fixed interval. The local clock time can shift
                when daylight saving changes.
              </p>
            </div>
          )}
        </fieldset>
        <div className="reminder-preview" aria-live="polite">
          <Clock size={19} />
          <div>
            <span>First reminder</span>
            <strong>
              {due ? reminderTimeLabel(due) : "Choose a valid date and time"}
            </strong>
            <small>
              {repeat
                ? `Then every ${amount || "…"} ${unit}${Number(amount) === 1 ? "" : "s"}`
                : "Once · only you will receive this"}
            </small>
          </div>
        </div>
        {error && (
          <p className="reminder-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            <Bell size={16} />
            {busy ? "Creating…" : "Create reminder"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
