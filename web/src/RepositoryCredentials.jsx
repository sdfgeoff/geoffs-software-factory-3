import React, { useEffect, useState } from "react";

export function useRepositoryCredentials(api, enabled) {
  const [credentials, setCredentials] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) {
      setCredentials([]);
      return;
    }
    let stale = false;
    api("/admin/repository-credentials")
      .then((rows) => {
        if (!stale) {
          setCredentials(rows);
          setError("");
        }
      })
      .catch((e) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [api, enabled]);
  const upsert = (row) =>
    setCredentials((previous) =>
      [...previous.filter((entry) => entry.id !== row.id), row].sort(
        (a, b) => a.id - b.id,
      ),
    );
  const remove = (id) =>
    setCredentials((previous) => previous.filter((entry) => entry.id !== id));
  return { credentials, error, upsert, remove };
}
const config = {
  git: {
    id: "git_credential_id",
    env: "credential_env",
    configured: "credential_configured",
    label: "Git token",
    envLabel: "Server credential environment variable",
  },
  github: {
    id: "github_credential_id",
    env: "github_token_env",
    configured: "github_token_configured",
    label: "GitHub token",
    envLabel: "GitHub token environment variable",
  },
};
export function credentialSelectionFields(fields, kind) {
  const setting = config[kind];
  if (!fields.has(setting.id)) return {};
  const source = fields.get(setting.id);
  if (source === "legacy")
    return {
      [setting.id]: null,
      ...(fields.get(setting.env)
        ? { [setting.env]: fields.get(setting.env) }
        : {}),
    };
  if (source) return { [setting.id]: Number(source) };
  return {
    [setting.id]: null,
    ...(fields.get("existing_repository") === "true"
      ? { [setting.env]: null }
      : {}),
  };
}
export function RepositoryCredentialField({
  api,
  kind,
  repository,
  credentials,
  onCreated,
  required = false,
}) {
  const setting = config[kind];
  const savedId = repository?.[setting.id];
  const legacyConfigured = !!repository?.[setting.configured] && !savedId;
  const [source, setSource] = useState(
    savedId ? String(savedId) : legacyConfigured ? "legacy" : "",
  );
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = () => {
    setAdding(false);
    setName("");
    setValue("");
    setError("");
  };
  return (
    <fieldset className="repository-credential-field">
      <label>
        {setting.label}
        <select
          name={setting.id}
          aria-label={setting.label}
          value={source}
          required={required}
          onChange={(event) => setSource(event.target.value)}
        >
          <option value="">
            {required ? "Choose a saved token" : "No saved token"}
          </option>
          {savedId && !credentials.some((entry) => entry.id === savedId) && (
            <option value={savedId}>Saved token #{savedId}</option>
          )}
          {credentials.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
          <option value="legacy">Legacy server environment variable</option>
        </select>
      </label>
      <button
        type="button"
        className="button subtle"
        onClick={() => (adding ? cancel() : setAdding(true))}
      >
        {adding
          ? `Cancel new ${setting.label.toLowerCase()}`
          : `Add ${setting.label.toLowerCase()}`}
      </button>
      {source === "legacy" && (
        <label className="legacy-credential-field">
          {setting.envLabel}
          <input
            name={setting.env}
            pattern="[A-Z_][A-Z0-9_]*"
            defaultValue=""
            required={!legacyConfigured}
            placeholder={
              kind === "github" ? "PROJECT_GITHUB_TOKEN" : "PROJECT_GIT_TOKEN"
            }
          />
          <small>
            {legacyConfigured
              ? "A server environment reference is configured. Leave blank to keep it."
              : "Advanced: enter an environment variable name only. Configure its token on the server."}
          </small>
        </label>
      )}
      {adding && (
        <div className="credential-inline-create">
          <label>
            New {setting.label.toLowerCase()} name
            <input
              aria-label={`New ${setting.label.toLowerCase()} name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              autoComplete="off"
            />
          </label>
          <label>
            New {setting.label.toLowerCase()} value
            <input
              aria-label={`New ${setting.label.toLowerCase()} value`}
              type="password"
              minLength={8}
              maxLength={16384}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>
          <small>
            Saved encrypted on the server. The token value is never shown again.
          </small>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={async () => {
              if (busy) return;
              if (!name.trim() || value.length < 8) {
                setError(
                  "Enter a token name and a token value of at least 8 characters.",
                );
                return;
              }
              setBusy(true);
              setError("");
              try {
                const row = await api("/admin/repository-credentials", {
                  method: "POST",
                  body: { name: name.trim(), value },
                });
                setValue("");
                setName("");
                setAdding(false);
                onCreated(row);
                setSource(String(row.id));
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : `Save ${setting.label.toLowerCase()}`}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
export function RepositoryCredentialsPanel({
  api,
  credentials,
  error,
  onSaved,
  onRemoved,
}) {
  const [creating, setCreating] = useState(false);
  return (
    <section
      className="orchestration-card repository-credentials-panel"
      aria-label="Saved repository tokens"
    >
      <h2>Saved repository tokens</h2>
      <p>
        Named tokens are encrypted in the server database. Only admins can
        create, replace, or delete them; token values are write-only.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="button subtle"
        onClick={() => setCreating((value) => !value)}
      >
        {creating ? "Cancel token creation" : "Add repository token"}
      </button>
      {creating && (
        <CredentialEditor
          api={api}
          onSaved={(row) => {
            onSaved(row);
            setCreating(false);
          }}
        />
      )}
      {!credentials.length && (
        <p className="muted">
          No saved tokens yet. Add one here or while configuring a repository.
        </p>
      )}
      {credentials.map((credential) => (
        <CredentialRow
          key={credential.id}
          api={api}
          credential={credential}
          onSaved={onSaved}
          onRemoved={onRemoved}
        />
      ))}
    </section>
  );
}
function CredentialRow({ api, credential, onSaved, onRemoved }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <article className="repository-token-row">
      <div className="repository-token-heading">
        <div>
          <strong>{credential.name}</strong>
          <small>
            Updated {new Date(credential.updated_at).toLocaleString()}
          </small>
        </div>
        <button
          type="button"
          className="button subtle"
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? "Cancel token editing" : "Rename or replace"}
        </button>
        <button
          type="button"
          className="button subtle"
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await api(`/admin/repository-credentials/${credential.id}`, {
                method: "DELETE",
              });
              onRemoved(credential.id);
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Delete token
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {editing && (
        <CredentialEditor
          api={api}
          credential={credential}
          onSaved={(row) => {
            onSaved(row);
            setEditing(false);
          }}
        />
      )}
    </article>
  );
}
function CredentialEditor({ api, credential, onSaved }) {
  const [name, setName] = useState(credential?.name || "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="orchestration-form repository-token-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          const row = await api(
            credential
              ? `/admin/repository-credentials/${credential.id}`
              : "/admin/repository-credentials",
            {
              method: credential ? "PATCH" : "POST",
              body: { name, ...(value ? { value } : {}) },
            },
          );
          setValue("");
          onSaved(row);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Token name
        <input
          name="credential_name"
          aria-label="Token name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={100}
          autoComplete="off"
        />
      </label>
      <label>
        {credential ? "Replacement token value" : "Token value"}
        <input
          aria-label={credential ? "Replacement token value" : "Token value"}
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          required={!credential}
          minLength={8}
          maxLength={16384}
          autoComplete="new-password"
          spellCheck={false}
        />
        <small>
          {credential
            ? "Leave blank to rename without replacing the token."
            : "The token is encrypted when saved and is never returned."}
        </small>
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button className="button primary" disabled={busy}>
        {busy
          ? "Saving…"
          : credential
            ? "Save token changes"
            : "Save repository token"}
      </button>
    </form>
  );
}
