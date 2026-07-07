"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Ticket,
  Loader2,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import Chat, { AgentUi } from "./Chat";

const JIRA_AGENT: AgentUi = {
  command: "jira",
  icon: Ticket,
  heading: "Jira agent",
  blurb:
    "Draft the Description here, or ask about issues, hierarchy, and the SOP. Use the form on the left to set every field live from Jira.",
  placeholder: "Ask the agent, or have it draft a description…",
  note: "Routes through the /jira skill · follows the Paytm Jira SOP",
  starters: [
    "Draft a description for the issue I'm filling in on the left.",
    "What issue type and parent should this be?",
    "Search my open issues in this project.",
    "What are the mandatory fields per the SOP?",
  ],
};

type Project = { id: string; key: string; name: string };
type IssueType = { id: string; name: string; subtask: boolean };
type Board = { id: number; name: string; type: string };
type Sprint = { id: number; name: string; state: string };
type Field = {
  fieldId: string;
  name: string;
  required: boolean;
  type?: string;
  items?: string;
  custom?: string;
  allowedValues: { id: string; label: string }[];
};

// Fields handled specially or not worth a generic input.
const SKIP = new Set([
  "project",
  "issuetype",
  "summary",
  "description",
  "attachment",
  "issuelinks",
  "reporter",
  "timetracking",
  "worklog",
  "customfield_10020", // Sprint — driven by the board/sprint pickers
]);

const SPRINT_FIELD = "customfield_10020";

async function getJSON(url: string) {
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

export default function JiraStudio() {
  const [project, setProject] = useState("");
  const [issueTypes, setIssueTypes] = useState<IssueType[]>([]);
  const [typeId, setTypeId] = useState("");
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState("");
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [fields, setFields] = useState<Field[]>([]);
  const [values, setValues] = useState<Record<string, any>>({});
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");

  const [loadingFields, setLoadingFields] = useState(false);
  const [showOptional, setShowOptional] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ key: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const typeName = issueTypes.find((t) => t.id === typeId)?.name || "";
  const hasSprintField = fields.some((f) => f.fieldId === SPRINT_FIELD);

  // Project → issue types + boards.
  useEffect(() => {
    if (!project) return;
    setTypeId("");
    setFields([]);
    setBoardId("");
    setSprints([]);
    getJSON(`/api/jira/issuetypes?project=${project}`)
      .then((d) => setIssueTypes(d.issueTypes || []))
      .catch((e) => setError(e.message));
    getJSON(`/api/jira/boards?project=${project}`)
      .then((d) => setBoards(d.boards || []))
      .catch(() => setBoards([]));
  }, [project]);

  // Issue type → create fields.
  const loadFields = useCallback(async (proj: string, tid: string) => {
    setLoadingFields(true);
    setFields([]);
    setValues({});
    try {
      const d = await getJSON(
        `/api/jira/fields?project=${proj}&issueType=${tid}`
      );
      setFields(d.fields || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingFields(false);
    }
  }, []);

  useEffect(() => {
    if (project && typeId) loadFields(project, typeId);
  }, [project, typeId, loadFields]);

  // Board → sprints.
  useEffect(() => {
    if (!boardId) {
      setSprints([]);
      return;
    }
    getJSON(`/api/jira/boards?board=${boardId}&sprints=1`)
      .then((d) => setSprints(d.sprints || []))
      .catch(() => setSprints([]));
  }, [boardId]);

  const setVal = (id: string, v: any) =>
    setValues((p) => ({ ...p, [id]: v }));

  // Shape a raw form value into the Jira create payload shape.
  const shape = (f: Field, raw: any): any => {
    if (raw === undefined || raw === "" || (Array.isArray(raw) && !raw.length))
      return undefined;
    const t = f.type;
    if (t === "array") {
      if (f.items === "string") return raw; // labels: string[]
      return (raw as string[]).map((id) => ({ id })); // options/components/versions
    }
    if (f.allowedValues.length || t === "priority" || t === "resolution")
      return { id: raw };
    if (t === "user") return { accountId: raw };
    if (t === "number") return Number(raw);
    if (f.fieldId === "parent") return { key: raw };
    return raw; // string / date / datetime
  };

  const draftDescription = async () => {
    if (!summary.trim()) {
      setError("Add a Summary first so the agent has something to describe.");
      return;
    }
    setDrafting(true);
    setError(null);
    try {
      const r = await fetch("/api/jira/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary,
          projectKey: project,
          issueType: typeName,
          notes: description,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Draft failed");
      setDescription(d.description || "");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDrafting(false);
    }
  };

  const create = async () => {
    setError(null);
    setResult(null);
    if (!project || !typeId || !summary.trim()) {
      setError("Project, issue type and summary are required.");
      return;
    }
    const payloadFields: Record<string, any> = {};
    for (const f of fields) {
      if (SKIP.has(f.fieldId)) continue;
      const shaped = shape(f, values[f.fieldId]);
      if (shaped !== undefined) payloadFields[f.fieldId] = shaped;
    }
    // Sprint (number) from the picker, if this type supports it.
    if (hasSprintField && values[SPRINT_FIELD])
      payloadFields[SPRINT_FIELD] = Number(values[SPRINT_FIELD]);

    setCreating(true);
    try {
      const r = await fetch("/api/jira/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: project,
          issueTypeId: typeId,
          summary,
          descriptionMarkdown: description,
          fields: payloadFields,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Create failed");
      setResult({ key: d.key, url: d.url });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const required = fields.filter((f) => f.required && !SKIP.has(f.fieldId));
  const optional = fields.filter((f) => !f.required && !SKIP.has(f.fieldId));

  return (
    <div className="flex h-full">
      {/* Form */}
      <div className="min-w-0 flex-1 overflow-y-auto bg-ink-50">
        <div className="mx-auto max-w-2xl px-6 py-6">
          <div className="mb-5 flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-500 text-white">
              <Ticket size={17} />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-ink-900">
                Create a Jira issue
              </h2>
              <p className="text-[11px] text-ink-400">
                Every field is pulled live from Jira for the chosen project &
                type
              </p>
            </div>
          </div>

          {/* Project / Type */}
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Project" required>
              <ProjectPicker value={project} onChange={setProject} />
            </Labeled>
            <Labeled label="Issue type" required>
              <select
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
                disabled={!project}
                className="jira-input"
              >
                <option value="">Select type…</option>
                {issueTypes
                  .filter((t) => !t.subtask)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </Labeled>
          </div>

          {/* Board / Sprint */}
          {boards.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Labeled label="Board">
                <select
                  value={boardId}
                  onChange={(e) => setBoardId(e.target.value)}
                  className="jira-input"
                >
                  <option value="">No board</option>
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.type})
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled
                label="Sprint"
                hint={!hasSprintField ? "not on this type" : undefined}
              >
                <select
                  value={values[SPRINT_FIELD] || ""}
                  onChange={(e) => setVal(SPRINT_FIELD, e.target.value)}
                  disabled={!boardId || !hasSprintField}
                  className="jira-input"
                >
                  <option value="">No sprint</option>
                  {sprints.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.state})
                    </option>
                  ))}
                </select>
              </Labeled>
            </div>
          )}

          {/* Summary */}
          <div className="mt-3">
            <Labeled label="Summary" required>
              <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Short, specific title"
                className="jira-input"
              />
            </Labeled>
          </div>

          {/* Description (Claude-drafted) */}
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-semibold text-ink-600">
                Description
              </label>
              <button
                onClick={draftDescription}
                disabled={drafting || !summary.trim()}
                className="inline-flex items-center gap-1 rounded-lg border border-brand-300 px-2 py-1 text-[11px] font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-40"
              >
                {drafting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Sparkles size={12} />
                )}
                {drafting ? "Drafting…" : "Draft with Claude"}
              </button>
            </div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={8}
              placeholder="Markdown. Click “Draft with Claude”, or write it yourself / refine it with the agent on the right."
              className="jira-input resize-y font-mono text-xs leading-relaxed"
            />
          </div>

          {loadingFields && (
            <div className="mt-4 flex items-center gap-2 text-xs text-ink-400">
              <Loader2 size={13} className="animate-spin" /> Loading fields for{" "}
              {typeName}…
            </div>
          )}

          {/* Required dynamic fields */}
          {required.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                Required fields
              </div>
              <div className="space-y-3">
                {required.map((f) => (
                  <FieldInput
                    key={f.fieldId}
                    field={f}
                    value={values[f.fieldId]}
                    project={project}
                    onChange={(v) => setVal(f.fieldId, v)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Optional dynamic fields */}
          {optional.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowOptional((s) => !s)}
                className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400 hover:text-ink-600"
              >
                {showOptional ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
                Optional fields ({optional.length})
              </button>
              {showOptional && (
                <div className="mt-2 space-y-3">
                  {optional.map((f) => (
                    <FieldInput
                      key={f.fieldId}
                      field={f}
                      value={values[f.fieldId]}
                      project={project}
                      onChange={(v) => setVal(f.fieldId, v)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Create */}
          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={create}
              disabled={creating || !project || !typeId || !summary.trim()}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-40"
            >
              {creating ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Ticket size={15} />
              )}
              Create issue
            </button>
            {result && (
              <a
                href={result.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:underline"
              >
                <CheckCircle2 size={14} /> {result.key} created{" "}
                <ExternalLink size={12} />
              </a>
            )}
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
        </div>
      </div>

      {/* Conversational agent */}
      <div className="hidden w-[440px] shrink-0 border-l border-ink-200 lg:block">
        <Chat agent={JIRA_AGENT} />
      </div>
    </div>
  );
}

function Labeled({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-ink-600">
        {label}
        {required && <span className="text-rose-500">*</span>}
        {hint && <span className="font-normal text-ink-400">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function FieldInput({
  field,
  value,
  project,
  onChange,
}: {
  field: Field;
  value: any;
  project: string;
  onChange: (v: any) => void;
}) {
  const t = field.type;

  // Single-select (priority, components-as-single, custom options)
  if (t !== "array" && field.allowedValues.length) {
    return (
      <Labeled label={field.name} required={field.required}>
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="jira-input"
        >
          <option value="">—</option>
          {field.allowedValues.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Labeled>
    );
  }

  // Multi-select (components, versions, multi-option customfields)
  if (t === "array" && field.allowedValues.length) {
    const arr: string[] = Array.isArray(value) ? value : [];
    return (
      <Labeled label={field.name} required={field.required} hint="multi-select">
        <select
          multiple
          value={arr}
          onChange={(e) =>
            onChange(Array.from(e.target.selectedOptions).map((o) => o.value))
          }
          className="jira-input h-24"
        >
          {field.allowedValues.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Labeled>
    );
  }

  // Labels (array of strings)
  if (t === "array" && field.items === "string") {
    return (
      <Labeled label={field.name} required={field.required} hint="comma-separated">
        <input
          value={Array.isArray(value) ? value.join(", ") : ""}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            )
          }
          className="jira-input"
        />
      </Labeled>
    );
  }

  if (t === "user") {
    return (
      <Labeled label={field.name} required={field.required}>
        <UserPicker
          project={project}
          value={value}
          onChange={onChange}
        />
      </Labeled>
    );
  }

  if (t === "date" || t === "datetime") {
    return (
      <Labeled label={field.name} required={field.required}>
        <input
          type={t === "date" ? "date" : "datetime-local"}
          value={value || ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="jira-input"
        />
      </Labeled>
    );
  }

  if (t === "number") {
    return (
      <Labeled label={field.name} required={field.required}>
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="jira-input"
        />
      </Labeled>
    );
  }

  // string / fallback — textarea for long custom text, input otherwise
  const long = (field.custom || "").includes("textarea");
  return (
    <Labeled label={field.name} required={field.required}>
      {long ? (
        <textarea
          value={value || ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          rows={3}
          className="jira-input resize-y"
        />
      ) : (
        <input
          value={value || ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="jira-input"
        />
      )}
    </Labeled>
  );
}

function ProjectPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Project | null>(null);

  // Parent reset (e.g. after create) clears the picked chip.
  useEffect(() => {
    if (!value) setPicked(null);
  }, [value]);

  // Search server-side as the user types (the list is far larger than 100).
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      const url = q.trim()
        ? `/api/jira/projects?query=${encodeURIComponent(q.trim())}`
        : "/api/jira/projects";
      getJSON(url)
        .then((d) => setList(d.projects || []))
        .catch(() => setList([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q, open]);

  if (picked) {
    return (
      <div className="flex items-center gap-2">
        <span className="truncate rounded-lg bg-ink-100 px-2 py-1.5 text-xs font-medium text-ink-700">
          {picked.key} — {picked.name}
        </span>
        <button
          onClick={() => {
            setPicked(null);
            onChange("");
            setQ("");
          }}
          className="shrink-0 text-[11px] text-ink-400 hover:text-brand-600"
        >
          change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search project by key or name…"
        className="jira-input"
      />
      {open && list.length > 0 && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-ink-200 bg-white shadow-lg">
            {list.map((p) => (
              <button
                key={p.key}
                onClick={() => {
                  onChange(p.key);
                  setPicked(p);
                  setOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-ink-50"
              >
                <span className="font-semibold text-ink-700">{p.key}</span>
                <span className="text-ink-400"> — {p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function UserPicker({
  project,
  value,
  onChange,
}: {
  project: string;
  value: string | undefined;
  onChange: (accountId: string | undefined) => void;
}) {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<
    { accountId: string; displayName: string; email?: string }[]
  >([]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string>("");

  useEffect(() => {
    if (!open || q.length < 2 || !project) return;
    const id = setTimeout(() => {
      getJSON(
        `/api/jira/users?project=${project}&query=${encodeURIComponent(q)}`
      )
        .then((d) => setUsers(d.users || []))
        .catch(() => setUsers([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q, open, project]);

  if (picked) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-ink-100 px-2 py-1 text-xs text-ink-700">
          {picked}
        </span>
        <button
          onClick={() => {
            setPicked("");
            onChange(undefined);
          }}
          className="text-[11px] text-ink-400 hover:text-rose-500"
        >
          change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        placeholder="Type a name…"
        className="jira-input"
      />
      {open && users.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-44 w-full overflow-y-auto rounded-lg border border-ink-200 bg-white shadow-lg">
          {users.map((u) => (
            <button
              key={u.accountId}
              onClick={() => {
                onChange(u.accountId);
                setPicked(u.displayName);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-xs hover:bg-ink-50"
            >
              {u.displayName}
              {u.email && (
                <span className="text-ink-400"> · {u.email}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
