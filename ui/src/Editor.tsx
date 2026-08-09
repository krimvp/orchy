import { type CSSProperties, useEffect, useState } from "react";
import { type Cycle, type Flow, type Member, type Schema, type Step, api, useLoad } from "./api";
import { Graph } from "./Graph";
import { Loading } from "./Runs";

const KINDS: Array<Step["kind"]> = ["agent", "call", "gate", "flow"];

/** A choice of a few, shown at once. A person sees every option and the one that holds. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          className={value === option.value ? "on" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

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
  if (!flow || !loaded.value) return <Loading lines={4} />;

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
      steps: [
        ...flow.steps,
        { id: name, kind: "agent", needs: [], prompt: "prompts/step.md", tools: ["read"], returns: OBJECT },
      ],
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
    <section className="stagger">
      <h1>{flow.name}</h1>
      <p className="note mono small" style={{ "--i": 1 } as CSSProperties}>
        {loaded.value.row.path}
      </p>

      <div className="bar-actions" style={{ "--i": 2 } as CSSProperties}>
        <button className="go" disabled={!editable || problems.length > 0} onClick={() => void save()}>
          Save
        </button>
        <button onClick={() => void api.startFlow(id).then(() => setNote("The run is in the queue."))}>Run</button>
        <button className="quiet" onClick={add}>
          Add a step
        </button>
        <span style={{ marginLeft: "auto" }}>
          {problems.length === 0 ? (
            <span className="pill done">valid</span>
          ) : (
            <span className="pill failed">
              {problems.length} problem{problems.length === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </div>

      {!editable && <p className="bad">This flow is TypeScript. The editor reads it and writes YAML only.</p>}
      {note && <p className="good">{note}</p>}
      {fault && <p className="bad">{fault}</p>}
      {problems.length > 0 && (
        <ul className="bad list">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="canvas" style={{ "--i": 3 } as CSSProperties}>
        <Graph steps={flow.steps} selected={chosen} onSelect={setChosen} />
      </div>

      <div className="split">
        <div>
          <h2>The flow</h2>
          <div className="panel">
            <label className="field">
              <span>Name</span>
              <input value={flow.name} onChange={(e) => setFlow({ ...flow, name: e.target.value })} />
            </label>
            <div className="field">
              <span>Workspace</span>
              <Segmented
                value={flow.workspace?.kind ?? "absent"}
                options={[
                  { value: "absent", label: "not declared" },
                  { value: "none", label: "none" },
                  { value: "git", label: "git" },
                ]}
                onChange={(kind) =>
                  setFlow({
                    ...flow,
                    workspace:
                      kind === "absent" ? undefined : kind === "none" ? { kind: "none" } : { kind: "git", path: "." },
                  })
                }
              />
            </div>
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
              <span>Harness</span>
              <select
                value={flow.harness ?? ""}
                onChange={(e) => setFlow({ ...flow, harness: e.target.value || undefined })}
              >
                <option value="">the default of the run</option>
                {(health.value?.adapters ?? []).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Model</span>
              <input
                value={flow.model ?? ""}
                placeholder="the default of the harness"
                onChange={(e) => setFlow({ ...flow, model: e.target.value || undefined })}
              />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
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
          {!step && (
            <div className="panel">
              <p className="empty" style={{ margin: 0 }}>
                Choose a step in the drawing, or add one.
              </p>
            </div>
          )}
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
  const others = flow.steps.filter((one) => one.id !== step.id);
  return (
    <div className="panel">
      <label className="field">
        <span>Id</span>
        <input value={step.id} onChange={(e) => onRename(e.target.value)} />
      </label>

      <div className="field">
        <span>Kind</span>
        <Segmented
          value={step.kind}
          options={KINDS.map((kind) => ({ value: kind, label: kind }))}
          onChange={(kind) => onChange(retype(step, kind))}
        />
      </div>

      <div className="field">
        <span>Needs</span>
        <div className="ticks">
          {others.length === 0 && <em className="empty">no other step</em>}
          {others.map((one) => (
            <label key={one.id}>
              <input
                type="checkbox"
                checked={step.needs.includes(one.id)}
                onChange={(e) =>
                  onChange({
                    needs: e.target.checked ? [...step.needs, one.id] : step.needs.filter((need) => need !== one.id),
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
            <input
              placeholder="the harness chooses"
              value={step.model ?? ""}
              onChange={(e) => onChange({ model: e.target.value || undefined })}
            />
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
        <div className="field set">
          <span>Promises to change</span>
          <Segmented
            value={step.changes === undefined ? "absent" : step.changes === "nothing" ? "nothing" : "paths"}
            options={[
              { value: "absent", label: "no promise" },
              { value: "nothing", label: "nothing" },
              { value: "paths", label: "these paths" },
            ]}
            onChange={(kind) =>
              onChange({
                changes: kind === "absent" ? undefined : kind === "nothing" ? "nothing" : { paths: ["docs"] },
              })
            }
          />
          {step.changes !== undefined && step.changes !== "nothing" && (
            <input
              style={{ marginTop: 10 }}
              value={step.changes.paths.join(", ")}
              placeholder="docs, README.md"
              onChange={(e) =>
                onChange({ changes: { paths: e.target.value.split(",").map((one) => one.trim()).filter(Boolean) } })
              }
            />
          )}
        </div>
      )}

      {step.kind !== "flow" && (
        <div className="field set">
          <span>Returns, as JSON Schema</span>
          <Json value={step.returns ?? OBJECT} onChange={(value) => onChange({ returns: value as Schema })} rows={9} />
        </div>
      )}

      {step.kind !== "flow" && step.needs.length > 0 && (
        <div className="field set">
          <label className="tick">
            <input
              type="checkbox"
              checked={Boolean(step.when)}
              onChange={(e) =>
                onChange({ when: e.target.checked ? { [step.needs[0] as string]: {} } : undefined })
              }
            />
            <span>Runs only when a step it needs says so</span>
          </label>
          {step.when && (
            <div style={{ marginTop: 14 }}>
              <Json value={step.when} onChange={(value) => onChange({ when: value as Step["when"] })} rows={4} />
            </div>
          )}
        </div>
      )}

      {(step.kind === "agent" || step.kind === "call") && <CycleFields step={step} flow={flow} onChange={onChange} />}

      {(step.kind === "agent" || step.kind === "call") && <FanoutFields step={step} onChange={onChange} />}

      <button className="danger" onClick={onRemove} style={{ marginTop: 18 }}>
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
    <div className="field set">
      <label className="tick">
        <input
          type="checkbox"
          checked={Boolean(cycle)}
          onChange={(e) =>
            onChange({
              cycle: e.target.checked ? { to: others[0]?.id ?? "", when: {}, limit: 3, policy: "escalate" } : undefined,
            })
          }
        />
        <span>Goes back to an earlier step</span>
      </label>
      {cycle && (
        <div style={{ marginTop: 14 }}>
          <div className="field">
            <span>Goes back</span>
            <Segmented
              value={cycle.when === "failed" ? "failed" : "value"}
              options={[
                { value: "value", label: "when the value holds" },
                { value: "failed", label: "when the step fails" },
              ]}
              onChange={(kind) =>
                onChange({
                  cycle:
                    kind === "failed"
                      ? { ...cycle, when: "failed", to: step.id }
                      : { ...cycle, when: {}, to: others[0]?.id ?? "" },
                })
              }
            />
          </div>
          {cycle.when !== "failed" && (
            <label className="field">
              <span>Back to</span>
              <select value={cycle.to} onChange={(e) => onChange({ cycle: { ...cycle, to: e.target.value } })}>
                {others.map((one) => (
                  <option key={one.id}>{one.id}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Limit</span>
            <input
              type="number"
              min={1}
              value={cycle.limit}
              onChange={(e) => onChange({ cycle: { ...cycle, limit: Number(e.target.value) } })}
            />
          </label>
          <div className="field">
            <span>At the limit</span>
            <Segmented
              value={cycle.policy}
              options={[
                { value: "escalate" as Cycle["policy"], label: "ask a person" },
                { value: "accept" as Cycle["policy"], label: "accept it" },
              ]}
              onChange={(policy) => onChange({ cycle: { ...cycle, policy } })}
            />
          </div>
          {cycle.when !== "failed" && (
            <div className="field" style={{ marginBottom: 0 }}>
              <span>When the value holds</span>
              <Json
                value={cycle.when}
                onChange={(value) => onChange({ cycle: { ...cycle, when: value as Record<string, unknown> } })}
                rows={3}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FanoutFields({ step, onChange }: { step: Step; onChange: (patch: Partial<Step>) => void }) {
  const members = step.fanout ?? [];
  const set = (index: number, patch: Partial<Member>) =>
    onChange({ fanout: members.map((one, at) => (at === index ? { ...one, ...patch } : one)) });

  return (
    <div className="field set">
      <label className="tick">
        <input
          type="checkbox"
          checked={members.length > 0}
          onChange={(e) => onChange({ fanout: e.target.checked ? [{ name: "one" }] : undefined })}
        />
        <span>Runs once for each member</span>
      </label>
      {members.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {members.map((member, index) => (
            <div key={index} className="member">
              <input placeholder="name" value={member.name} onChange={(e) => set(index, { name: e.target.value })} />
              {/* A call step holds no model, so the editor never offers one. */}
              {step.kind === "agent" && (
                <input
                  placeholder="model"
                  value={member.model ?? ""}
                  onChange={(e) => set(index, { model: e.target.value || undefined })}
                />
              )}
              <input
                placeholder={step.kind === "call" ? "module" : "prompt"}
                value={(step.kind === "call" ? member.module : member.prompt) ?? ""}
                onChange={(e) =>
                  set(
                    index,
                    step.kind === "call"
                      ? { module: e.target.value || undefined }
                      : { prompt: e.target.value || undefined },
                  )
                }
              />
              <input
                placeholder="holds, as JSON"
                value={member.with ? JSON.stringify(member.with) : ""}
                onChange={(e) => set(index, { with: read(e.target.value) })}
              />
              <button
                className="quiet"
                onClick={() => onChange({ fanout: members.filter((_one, at) => at !== index) })}
              >
                Remove
              </button>
            </div>
          ))}
          <button className="quiet" onClick={() => onChange({ fanout: [...members, { name: next(members) }] })}>
            Add a member
          </button>
        </div>
      )}
    </div>
  );
}

/** Keeps the text while a person types, and reports the value when it parses. */
/** Nothing when the text is not JSON, so a half-typed value writes no field. */
function read(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function Json({ value, onChange, rows }: { value: unknown; onChange: (value: unknown) => void; rows: number }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [bad, setBad] = useState<string>();

  return (
    <>
      <textarea
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

function next(members: Member[]): string {
  let count = members.length + 1;
  while (members.some((one) => one.name === `one-${count}`)) count += 1;
  return `one-${count}`;
}
