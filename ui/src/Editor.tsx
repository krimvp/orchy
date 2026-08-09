import { useEffect, useState } from "react";
import { type Cycle, type Flow, type Member, type Schema, type Step, api, useLoad } from "./api";
import { Graph } from "./Graph";

const KINDS = ["agent", "call", "gate", "flow"] as const;

export function Editor({ id }: { id: number }) {
  const health = useLoad(() => api.health(), []);
  const loaded = useLoad(() => api.flow(id), [id]);
  const [flow, setFlow] = useState<Flow>();
  const [chosen, setChosen] = useState<string>();
  const [problems, setProblems] = useState<string[]>([]);
  const [note, setNote] = useState<string>();
  const [fault, setFault] = useState<string>();

  useEffect(() => {
    if (loaded.value) {
      setFlow(loaded.value.flow);
      setProblems(loaded.value.problems);
    }
  }, [loaded.value]);

  // The runner owns the rules, so the editor asks it rather than repeating them.
  useEffect(() => {
    if (!flow) return;
    const timer = setTimeout(() => {
      void api
        .validate(flow)
        .then((answer) => setProblems(answer.problems))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [flow]);

  if (loaded.error) return <p className="bad">{loaded.error}</p>;
  if (!flow || !loaded.value) return <p className="empty">Reading the flow…</p>;

  const editable = loaded.value.editable;
  const step = flow.steps.find((one) => one.id === chosen);

  const change = (stepId: string, patch: Partial<Step>) =>
    setFlow({
      ...flow,
      steps: flow.steps.map((one) => (one.id === stepId ? clean({ ...one, ...patch }) : one)),
    });

  const rename = (from: string, to: string) => {
    setChosen(to);
    setFlow({
      ...flow,
      steps: flow.steps.map((one) => ({
        ...(one.id === from ? { ...one, id: to } : one),
        needs: one.needs.map((need) => (need === from ? to : need)),
        ...(one.cycle?.to === from ? { cycle: { ...one.cycle, to } } : {}),
      })),
    });
  };

  const add = () => {
    const name = free(flow, "step");
    setFlow({
      ...flow,
      steps: [...flow.steps, { id: name, kind: "agent", needs: [], prompt: "prompts/step.md", tools: ["read"], returns: OBJECT }],
    });
    setChosen(name);
  };

  const remove = (stepId: string) => {
    setChosen(undefined);
    setFlow({
      ...flow,
      steps: flow.steps
        .filter((one) => one.id !== stepId)
        .map((one) => ({ ...one, needs: one.needs.filter((need) => need !== stepId) })),
    });
  };

  const save = () =>
    api
      .saveFlow(id, flow)
      .then((answer) => {
        setProblems(answer.problems);
        setNote(answer.saved ? "Saved to the file." : undefined);
        setFault(answer.saved ? undefined : "The flow is not valid, so nothing was written.");
      })
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message)));

  return (
    <section>
      <h1>{flow.name}</h1>
      <p className="note mono small">{loaded.value.row.path}</p>
      {!editable && <p className="bad">This flow is TypeScript. The editor reads it and writes YAML only.</p>}

      <div className="row">
        <button className="go" disabled={!editable || problems.length > 0} onClick={() => void save()}>
          Save
        </button>
        <button onClick={() => void api.startFlow(id).then(() => setNote("The run is in the queue."))}>Run</button>
        <button onClick={add}>Add a step</button>
      </div>
      {note && <p className="good">{note}</p>}
      {fault && <p className="bad">{fault}</p>}
      {problems.length > 0 && (
        <ul className="bad list">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <Graph steps={flow.steps} selected={chosen} onSelect={setChosen} />

      <div className="split">
        <div>
          <h2>The flow</h2>
          <div className="panel">
            <label className="field">
              <span>Name</span>
              <input value={flow.name} onChange={(e) => setFlow({ ...flow, name: e.target.value })} />
            </label>
            <label className="field">
              <span>Workspace</span>
              <select
                value={flow.workspace?.kind ?? "absent"}
                onChange={(e) =>
                  setFlow({
                    ...flow,
                    workspace:
                      e.target.value === "absent"
                        ? undefined
                        : e.target.value === "none"
                          ? { kind: "none" }
                          : { kind: "git", path: "." },
                  })
                }
              >
                <option value="absent">not declared</option>
                <option value="none">none</option>
                <option value="git">git</option>
              </select>
            </label>
            {flow.workspace?.kind === "git" && (
              <label className="field">
                <span>Path</span>
                <input
                  value={flow.workspace.path}
                  onChange={(e) => setFlow({ ...flow, workspace: { kind: "git", path: e.target.value } })}
                />
              </label>
            )}
            <label className="field">
              <span>Steps at once</span>
              <input
                type="number"
                min={1}
                value={flow.parallel ?? 8}
                onChange={(e) => setFlow({ ...flow, parallel: Number(e.target.value) })}
              />
            </label>
          </div>
        </div>

        <div>
          <h2>The step</h2>
          {!step && <p className="empty">Choose a step in the drawing, or add one.</p>}
          {step && (
            <StepFields
              key={step.id}
              flow={flow}
              step={step}
              tools={health.value?.tools ?? []}
              adapters={health.value?.adapters ?? []}
              onChange={(patch) => change(step.id, patch)}
              onRename={(to) => rename(step.id, to)}
              onRemove={() => remove(step.id)}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function StepFields({
  flow,
  step,
  tools,
  adapters,
  onChange,
  onRename,
  onRemove,
}: {
  flow: Flow;
  step: Step;
  tools: string[];
  adapters: string[];
  onChange: (patch: Partial<Step>) => void;
  onRename: (to: string) => void;
  onRemove: () => void;
}) {
  const earlier = flow.steps.filter((one) => one.id !== step.id);
  return (
    <div className="panel">
      <label className="field">
        <span>Id</span>
        <input value={step.id} onChange={(e) => onRename(e.target.value)} />
      </label>

      <label className="field">
        <span>Kind</span>
        <select value={step.kind} onChange={(e) => onChange(retype(step, e.target.value as Step["kind"]))}>
          {KINDS.map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
      </label>

      <div className="field">
        <span>Needs</span>
        <div className="ticks">
          {earlier.length === 0 && <em className="empty">no other step</em>}
          {earlier.map((one) => (
            <label key={one.id}>
              <input
                type="checkbox"
                checked={step.needs.includes(one.id)}
                onChange={(e) =>
                  onChange({
                    needs: e.target.checked
                      ? [...step.needs, one.id]
                      : step.needs.filter((need) => need !== one.id),
                  })
                }
              />
              {one.id}
            </label>
          ))}
        </div>
      </div>

      {step.kind === "agent" && (
        <>
          <label className="field">
            <span>Prompt</span>
            <input value={step.prompt ?? ""} onChange={(e) => onChange({ prompt: e.target.value })} />
          </label>
          <label className="field">
            <span>Harness</span>
            <select value={step.harness ?? ""} onChange={(e) => onChange({ harness: e.target.value || undefined })}>
              <option value="">the default of the run</option>
              {adapters.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <input value={step.model ?? ""} onChange={(e) => onChange({ model: e.target.value || undefined })} />
          </label>
          <div className="field">
            <span>Tools</span>
            <div className="ticks">
              {tools.map((name) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={step.tools?.includes(name) ?? false}
                    onChange={(e) =>
                      onChange({
                        tools: e.target.checked
                          ? [...(step.tools ?? []), name]
                          : (step.tools ?? []).filter((tool) => tool !== name),
                      })
                    }
                  />
                  {name}
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      {step.kind === "call" && (
        <label className="field">
          <span>Module</span>
          <input value={step.module ?? ""} onChange={(e) => onChange({ module: e.target.value })} />
        </label>
      )}

      {step.kind === "gate" && (
        <label className="field">
          <span>Question</span>
          <textarea rows={2} value={step.question ?? ""} onChange={(e) => onChange({ question: e.target.value })} />
        </label>
      )}

      {step.kind === "flow" && (
        <label className="field">
          <span>Flow file</span>
          <input value={step.flow ?? ""} onChange={(e) => onChange({ flow: e.target.value })} />
        </label>
      )}

      {(step.kind === "agent" || step.kind === "call") && (
        <label className="field tick">
          <input
            type="checkbox"
            checked={step.changes === false}
            onChange={(e) => onChange({ changes: e.target.checked ? false : undefined })}
          />
          <span>Promises to change nothing in the workspace</span>
        </label>
      )}

      {step.kind !== "flow" && (
        <div className="field">
          <span>Returns, as JSON Schema</span>
          <Json value={step.returns ?? OBJECT} onChange={(value) => onChange({ returns: value as Schema })} rows={9} />
        </div>
      )}

      {(step.kind === "agent" || step.kind === "call") && (
        <CycleFields step={step} flow={flow} onChange={onChange} />
      )}

      {(step.kind === "agent" || step.kind === "call") && (
        <FanoutFields step={step} onChange={onChange} />
      )}

      <button className="danger" onClick={onRemove}>
        Delete this step
      </button>
    </div>
  );
}

function CycleFields({
  step,
  flow,
  onChange,
}: {
  step: Step;
  flow: Flow;
  onChange: (patch: Partial<Step>) => void;
}) {
  const others = flow.steps.filter((one) => one.id !== step.id);
  const cycle = step.cycle;
  return (
    <div className="field group">
      <label className="tick">
        <input
          type="checkbox"
          checked={Boolean(cycle)}
          onChange={(e) =>
            onChange({
              cycle: e.target.checked
                ? { to: others[0]?.id ?? "", when: {}, limit: 3, policy: "escalate" }
                : undefined,
            })
          }
        />
        <span>Goes back to an earlier step</span>
      </label>
      {cycle && (
        <>
          <label className="field">
            <span>Back to</span>
            <select value={cycle.to} onChange={(e) => onChange({ cycle: { ...cycle, to: e.target.value } })}>
              {others.map((one) => (
                <option key={one.id}>{one.id}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Limit</span>
            <input
              type="number"
              min={1}
              value={cycle.limit}
              onChange={(e) => onChange({ cycle: { ...cycle, limit: Number(e.target.value) } })}
            />
          </label>
          <label className="field">
            <span>At the limit</span>
            <select
              value={cycle.policy}
              onChange={(e) => onChange({ cycle: { ...cycle, policy: e.target.value as Cycle["policy"] } })}
            >
              <option value="escalate">ask a person</option>
              <option value="accept">accept the disagreement</option>
            </select>
          </label>
          <div className="field">
            <span>When the value holds</span>
            <Json
              value={cycle.when}
              onChange={(value) => onChange({ cycle: { ...cycle, when: value as Record<string, unknown> } })}
              rows={3}
            />
          </div>
        </>
      )}
    </div>
  );
}

function FanoutFields({ step, onChange }: { step: Step; onChange: (patch: Partial<Step>) => void }) {
  const members = step.fanout ?? [];
  const set = (index: number, patch: Partial<Member>) =>
    onChange({ fanout: members.map((one, at) => (at === index ? { ...one, ...patch } : one)) });

  return (
    <div className="field group">
      <label className="tick">
        <input
          type="checkbox"
          checked={members.length > 0}
          onChange={(e) => onChange({ fanout: e.target.checked ? [{ name: "one" }] : undefined })}
        />
        <span>Runs once for each member</span>
      </label>
      {members.map((member, index) => (
        <div key={index} className="member">
          <input placeholder="name" value={member.name} onChange={(e) => set(index, { name: e.target.value })} />
          <input
            placeholder="model"
            value={member.model ?? ""}
            onChange={(e) => set(index, { model: e.target.value || undefined })}
          />
          <input
            placeholder={step.kind === "call" ? "module" : "prompt"}
            value={(step.kind === "call" ? member.module : member.prompt) ?? ""}
            onChange={(e) =>
              set(index, step.kind === "call" ? { module: e.target.value || undefined } : { prompt: e.target.value || undefined })
            }
          />
          <button onClick={() => onChange({ fanout: members.filter((_one, at) => at !== index) })}>Remove</button>
        </div>
      ))}
      {members.length > 0 && (
        <button onClick={() => onChange({ fanout: [...members, { name: free2(members) }] })}>Add a member</button>
      )}
    </div>
  );
}

/** Keeps the text while a person types, and reports the value when it parses. */
function Json({ value, onChange, rows }: { value: unknown; onChange: (value: unknown) => void; rows: number }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [bad, setBad] = useState<string>();

  return (
    <>
      <textarea
        className="mono"
        rows={rows}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setBad(undefined);
          } catch (problem) {
            setBad(problem instanceof Error ? problem.message : String(problem));
          }
        }}
      />
      {bad && <span className="bad small">{bad}</span>}
    </>
  );
}

const OBJECT: Schema = { type: "object", required: [], properties: {} };

/** A field that the new kind cannot hold must go, or the run refuses the step. */
function retype(step: Step, kind: Step["kind"]): Partial<Step> {
  const bare: Partial<Step> = {
    kind,
    prompt: undefined,
    module: undefined,
    question: undefined,
    flow: undefined,
    tools: undefined,
    harness: undefined,
    model: undefined,
    changes: undefined,
    cycle: undefined,
    fanout: undefined,
    returns: step.returns ?? OBJECT,
  };
  if (kind === "agent") return { ...bare, prompt: step.prompt ?? "prompts/step.md", tools: step.tools ?? ["read"] };
  if (kind === "call") return { ...bare, module: step.module ?? "step.ts" };
  if (kind === "gate") return { ...bare, question: step.question ?? "What do you decide?" };
  return { ...bare, flow: step.flow ?? "inner/flow.yaml", returns: undefined };
}

/** A key that holds nothing must leave the file, not sit in it as null. */
function clean(step: Step): Step {
  const kept = Object.entries(step).filter(([, value]) => value !== undefined);
  return Object.fromEntries(kept) as unknown as Step;
}

function free(flow: Flow, stem: string): string {
  let name = stem;
  let count = 1;
  while (flow.steps.some((one) => one.id === name)) name = `${stem}-${++count}`;
  return name;
}

function free2(members: Member[]): string {
  let count = members.length + 1;
  while (members.some((one) => one.name === `one-${count}`)) count += 1;
  return `one-${count}`;
}
