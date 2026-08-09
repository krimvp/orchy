import { type CSSProperties, useEffect, useState } from "react";
import {
  type Changes,
  type Computed,
  type Cycle,
  type Flow,
  type Member,
  type Operator,
  type Schema,
  type Step,
  api,
  computedOf,
  membersOf,
  operatorOf,
  useLoad,
} from "./api";
import { Graph } from "./Graph";
import { Contract } from "./Run";
import { Loading } from "./Runs";

const KINDS: Array<Step["kind"]> = ["agent", "call", "gate", "flow"];

/** The set of operators lives in the runner, so the daemon sends it and the page draws it. */
const MATCH = "Each row reads one key of the value. The daemon names the operators.";

/** A match that no row draws stays as it is, and the daemon still checks it. */
const KEPT = "This condition holds something that no row draws, so the editor keeps it as JSON.";

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
  const [starting, setStarting] = useState(false);

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

  // The flow says what it takes, so the page asks for those values and no others.
  const start = (values?: Record<string, unknown>) =>
    api
      .startFlow(id, values)
      .then(() => (setStarting(false), setFault(undefined), setNote("The run is in the queue.")))
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message)));

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
        <button onClick={() => (flow.takes ? setStarting(true) : void start())}>Run</button>
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

      {starting && flow.takes && (
        <div className="panel gate">
          <h2>This run takes values</h2>
          <Contract
            schema={flow.takes}
            label="Start the run"
            onSend={(values) => void start(values as Record<string, unknown>)}
          />
        </div>
      )}

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
            <label className="field">
              <span>Steps at once</span>
              <input
                type="number"
                min={1}
                value={flow.parallel ?? 8}
                onChange={(e) => setFlow({ ...flow, parallel: Number(e.target.value) })}
              />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Budget, in dollars</span>
              <input
                type="number"
                min={0}
                step={0.01}
                placeholder="no budget"
                value={flow.budget ?? ""}
                onChange={(e) => setFlow({ ...flow, budget: e.target.value === "" ? undefined : Number(e.target.value) })}
              />
            </label>

            <ChangesFields
              title="Every step promises to change"
              changes={flow.changes}
              onChange={(changes) => setFlow({ ...flow, changes })}
            />
            <SchemaFields
              title="Takes values from the run"
              schema={flow.takes}
              onChange={(takes) => setFlow({ ...flow, takes })}
            />
            <SchemaFields
              title="Returns the value of the step it ends with"
              schema={flow.returns}
              onChange={(returns) => setFlow({ ...flow, returns })}
            />
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
              operators={health.value?.operators ?? []}
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
  operators,
  onChange,
  onRename,
  onRemove,
}: {
  flow: Flow;
  step: Step;
  tools: string[];
  adapters: string[];
  operators: Operator[];
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
        <>
          <ChangesFields
            title="Promises to change"
            changes={step.changes}
            onChange={(changes) => onChange({ changes })}
          />
          <SchemaFields
            title="Takes values that must reach it"
            schema={step.takes}
            onChange={(takes) => onChange({ takes })}
          />
        </>
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
          {step.when && <WhenFields flow={flow} step={step} operators={operators} onChange={onChange} />}
        </div>
      )}

      {/* A gate cycles as well, because a person sends the run back. */}
      {step.kind !== "flow" && <CycleFields step={step} flow={flow} operators={operators} onChange={onChange} />}

      {(step.kind === "agent" || step.kind === "call") && <FanoutFields step={step} onChange={onChange} />}

      <button className="danger" onClick={onRemove} style={{ marginTop: 18 }}>
        Delete this step
      </button>
    </div>
  );
}

/**
 * The promise of invariant 5. A flow holds one for every step that declares
 * none, and a step holds its own, so both draw the same control.
 */
function ChangesFields({
  title,
  changes,
  onChange,
}: {
  title: string;
  changes?: Changes;
  onChange: (changes?: Changes) => void;
}) {
  const kind =
    changes === undefined ? "absent" : changes === "nothing" ? "nothing" : "except" in changes ? "except" : "paths";
  const paths = typeof changes === "object" ? ("except" in changes ? changes.except : changes.paths) : [];
  const write = (list: string[]) => onChange(kind === "except" ? { except: list } : { paths: list });

  return (
    <div className="field set">
      <span>{title}</span>
      <Segmented
        value={kind}
        options={[
          { value: "absent", label: "no promise" },
          { value: "nothing", label: "nothing" },
          { value: "paths", label: "only these paths" },
          { value: "except", label: "everything but these" },
        ]}
        onChange={(next) => {
          if (next === "absent") return onChange(undefined);
          if (next === "nothing") return onChange("nothing");
          const list = paths.length > 0 ? paths : ["docs"];
          onChange(next === "except" ? { except: list } : { paths: list });
        }}
      />
      {(kind === "paths" || kind === "except") && (
        <input
          style={{ marginTop: 10 }}
          value={paths.join(", ")}
          placeholder="docs, README.md"
          onChange={(e) => write(e.target.value.split(",").map((one) => one.trim()).filter(Boolean))}
        />
      )}
    </div>
  );
}

/**
 * A contract is JSON Schema, so the editor writes the schema itself. A builder
 * for a schema is a second language beside the one that a file already holds.
 */
function SchemaFields({
  title,
  schema,
  onChange,
}: {
  title: string;
  schema?: Schema;
  onChange: (schema?: Schema) => void;
}) {
  return (
    <div className="field set">
      <label className="tick">
        <input
          type="checkbox"
          checked={Boolean(schema)}
          onChange={(e) => onChange(e.target.checked ? OBJECT : undefined)}
        />
        <span>{title}</span>
      </label>
      {schema && (
        <div style={{ marginTop: 14 }}>
          <Json value={schema} onChange={(value) => onChange(value as Schema)} rows={7} />
        </div>
      )}
    </div>
  );
}

function CycleFields({
  step,
  flow,
  operators,
  onChange,
}: {
  step: Step;
  flow: Flow;
  operators: Operator[];
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
              <span>When the value of this step holds</span>
              {/* A cycle reads the value of the step it sits on. See ADR 0016. */}
              <MatchFields
                match={cycle.when}
                keys={keysOf(step)}
                operators={operators}
                onChange={(when) => onChange({ cycle: { ...cycle, when } })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The condition of a step. It names a step that this step needs, and the match
 * against the value of that step. `validate()` refuses a step that this one
 * does not need, so the control offers only the steps it needs.
 */
function WhenFields({
  flow,
  step,
  operators,
  onChange,
}: {
  flow: Flow;
  step: Step;
  operators: Operator[];
  onChange: (patch: Partial<Step>) => void;
}) {
  const when = record(step.when);
  // A condition that reads no step is a field that does nothing, so it goes.
  const write = (entries: Array<[string, unknown]>) =>
    onChange({ when: entries.length > 0 ? (Object.fromEntries(entries) as Step["when"]) : undefined });

  if (!when) {
    return (
      <div style={{ marginTop: 14 }}>
        <Json value={step.when} onChange={(value) => onChange({ when: value as Step["when"] })} rows={4} />
        <span className="note small">{KEPT}</span>
      </div>
    );
  }

  const entries = Object.entries(when);
  const named = entries.map(([id]) => id);
  const free = step.needs.filter((need) => !named.includes(need));

  return (
    <div style={{ marginTop: 14 }}>
      {entries.map(([id, match], index) => (
        <div key={id} className="field">
          <span>When the value of</span>
          {/* The step it reads now, and every step it needs and does not read yet. */}
          <select
            value={id}
            onChange={(e) => write(entries.map((one, at) => (at === index ? [e.target.value, match] : one)))}
          >
            {[...(step.needs.includes(id) ? [] : [id]), ...step.needs.filter((need) => free.includes(need) || need === id)].map(
              (need) => (
                <option key={need}>{need}</option>
              ),
            )}
          </select>
          <div style={{ marginTop: 10 }}>
            <MatchFields
              match={match}
              keys={keysOf(flow.steps.find((one) => one.id === id))}
              operators={operators}
              onChange={(next) => write(entries.map((one, at) => (at === index ? [id, next] : one)))}
            />
            <button className="quiet" onClick={() => write(entries.filter((_one, at) => at !== index))}>
              Read no value of {id}
            </button>
          </div>
        </div>
      ))}
      {free.length > 0 && (
        <button className="quiet" onClick={() => write([...entries, [free[0] as string, {}]])}>
          Read another step
        </button>
      )}
    </div>
  );
}

/**
 * A match against one value: one row for each key it reads, the operator, and
 * what it compares against. The daemon names the operators, so the page draws
 * the list and holds no copy of it.
 *
 * A match that no row draws stays as JSON, in the way a contract does, so a
 * person keeps what they wrote.
 */
function MatchFields({
  match,
  keys,
  operators,
  onChange,
}: {
  match: unknown;
  keys?: string[];
  operators: Operator[];
  onChange: (match: Record<string, unknown>) => void;
}) {
  const [asJson, setAsJson] = useState(false);
  const held = record(match);
  const rows = held && Object.entries(held).map(([key, value]) => ({ key, held: operatorOf(value, operators) }));
  const drawn = Boolean(rows?.every((row) => row.held && fits(row.held[0], row.held[1])));

  // The daemon names the operators, so a page that waits for it draws no row.
  const waiting = operators.length === 0;

  if (!rows || !drawn || asJson) {
    return (
      <>
        <Json value={match} onChange={(value) => onChange(value as Record<string, unknown>)} rows={3} />
        <span className="note small">{drawn || waiting ? MATCH : KEPT}</span>
        {drawn && !waiting && (
          <button className="quiet" onClick={() => setAsJson(false)}>
            Draw the rows
          </button>
        )}
      </>
    );
  }

  const entries = Object.entries(held);
  const write = (next: Array<[string, unknown]>) => onChange(Object.fromEntries(next));
  const free = (keys ?? []).filter((key) => !entries.some(([one]) => one === key));
  const first = operators[0];

  return (
    <>
      {rows.map((row, index) => {
        const [operator, argument] = row.held as [Operator, unknown];
        const at = (key: string, value: unknown) =>
          write(entries.map((one, place) => (place === index ? [key, value] : one)));
        return (
          <div key={row.key} className="member">
            {keys ? (
              <select value={row.key} onChange={(e) => at(e.target.value, { [operator.name]: argument })}>
                {[row.key, ...free].map((key) => (
                  <option key={key}>{key}</option>
                ))}
              </select>
            ) : (
              <input value={row.key} onChange={(e) => at(e.target.value, { [operator.name]: argument })} />
            )}
            <select
              value={operator.name}
              onChange={(e) => {
                const next = operators.find((one) => one.name === e.target.value) as Operator;
                at(row.key, { [next.name]: takes(next, argument) });
              }}
            >
              {operators.map((one) => (
                <option key={one.name}>{one.name}</option>
              ))}
            </select>
            <Argument
              operator={operator}
              argument={argument}
              onChange={(value) => at(row.key, { [operator.name]: value })}
            />
            <button className="quiet" onClick={() => write(entries.filter((_one, place) => place !== index))}>
              Remove
            </button>
          </div>
        );
      })}
      {keys?.length === 0 && <em className="empty">the step it reads declares no key</em>}
      {first && (keys === undefined || free.length > 0) && (
        <button
          className="quiet"
          onClick={() => write([...entries, [free[0] ?? "", { [first.name]: takes(first, undefined) }]])}
        >
          Add a key
        </button>
      )}
      <button className="quiet" onClick={() => setAsJson(true)}>
        Write it as JSON
      </button>
      <span className="note small">{MATCH}</span>
    </>
  );
}

/** What the operator compares against: a boolean, a number, or the value itself. */
function Argument({
  operator,
  argument,
  onChange,
}: {
  operator: Operator;
  argument: unknown;
  onChange: (value: unknown) => void;
}) {
  if (operator.reads === "boolean") {
    return (
      <select value={String(argument)} onChange={(e) => onChange(e.target.value === "true")}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (operator.reads === "number") {
    return <input type="number" value={String(argument)} onChange={(e) => onChange(Number(e.target.value))} />;
  }
  return <JsonLine value={argument} onChange={onChange} />;
}

/**
 * One line of JSON, which keeps the text while a person types. A text that is
 * not JSON is the word itself, because a person who types `high` means "high".
 */
function JsonLine({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value) ?? "");

  return (
    <input
      value={text}
      placeholder={`"high"`}
      onChange={(e) => {
        setText(e.target.value);
        try {
          onChange(JSON.parse(e.target.value));
        } catch {
          onChange(e.target.value);
        }
      }}
    />
  );
}

/** The keys a step declares, or nothing when it declares none and any key holds. */
function keysOf(step?: Step): string[] | undefined {
  const properties = step?.returns?.properties as Record<string, unknown> | undefined;
  return properties && Object.keys(properties);
}

/** The value as a plain object, or nothing when it is not one. */
function record(value: unknown): Record<string, unknown> | undefined {
  const held = typeof value === "object" && value !== null && !Array.isArray(value);
  return held ? (value as Record<string, unknown>) : undefined;
}

/** A row draws an operator whose value is what the operator reads. */
function fits(operator: Operator, argument: unknown): boolean {
  return operator.reads === "value" || typeof argument === operator.reads;
}

/** What a row holds when it changes operator, so the new one reads its value. */
function takes(operator: Operator, argument: unknown): unknown {
  if (operator.reads === "boolean") return typeof argument === "boolean" ? argument : true;
  if (operator.reads === "number") return typeof argument === "number" ? argument : 0;
  return argument ?? "";
}

function FanoutFields({ step, onChange }: { step: Step; onChange: (patch: Partial<Step>) => void }) {
  const members = membersOf(step);
  const computed = computedOf(step);
  const set = (index: number, patch: Partial<Member>) =>
    onChange({ fanout: (members ?? []).map((one, at) => (at === index ? { ...one, ...patch } : one)) });

  return (
    <div className="field set">
      <span>Runs once for each member</span>
      <Segmented
        value={members ? "members" : computed ? "computed" : "absent"}
        options={[
          { value: "absent", label: "no fanout" },
          { value: "members", label: "these members" },
          { value: "computed", label: "a list a step returns" },
        ]}
        onChange={(kind) =>
          onChange({
            fanout:
              kind === "absent"
                ? undefined
                : kind === "members"
                  ? [{ name: "one" }]
                  : { step: step.needs[0] ?? "", key: "" },
          })
        }
      />
      {computed && <ComputedFields step={step} computed={computed} onChange={onChange} />}
      {members && (
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

/**
 * Where the run finds the list: a step that this step needs, and the key of the
 * value of that step. The run expands this one, so the drawing shows no count.
 */
function ComputedFields({
  step,
  computed,
  onChange,
}: {
  step: Step;
  computed: Computed;
  onChange: (patch: Partial<Step>) => void;
}) {
  return (
    <div style={{ marginTop: 14 }}>
      <label className="field">
        <span>The step that returns the list</span>
        <select
          value={computed.step}
          onChange={(e) => onChange({ fanout: { ...computed, step: e.target.value } })}
        >
          <option value="">choose a step this one needs</option>
          {step.needs.map((need) => (
            <option key={need}>{need}</option>
          ))}
        </select>
      </label>
      <label className="field" style={{ marginBottom: 0 }}>
        <span>The key that holds the list</span>
        <input
          placeholder="packages"
          value={computed.key}
          onChange={(e) => onChange({ fanout: { ...computed, key: e.target.value } })}
        />
      </label>
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

/**
 * A field that the new kind cannot hold must go, or the run refuses the step. A
 * field that the new kind holds must stay, or the editor drops it in silence.
 */
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
    with: undefined,
    takes: undefined,
    changes: undefined,
    fanout: undefined,
    returns: step.returns ?? OBJECT,
  };
  // An agent step and a call step both act in the workspace, both take values,
  // and both fan out. Every kind holds a cycle, so no kind drops one.
  const acts = { with: step.with, takes: step.takes, changes: step.changes, fanout: step.fanout };
  if (kind === "agent") {
    return {
      ...bare,
      ...acts,
      harness: step.harness,
      model: step.model,
      prompt: step.prompt ?? "prompts/step.md",
      tools: step.tools ?? ["read"],
    };
  }
  if (kind === "call") return { ...bare, ...acts, module: step.module ?? "step.ts" };
  if (kind === "gate") return { ...bare, question: step.question ?? "What do you decide?" };
  // A flow step holds the values it passes down, and it holds no condition.
  return { ...bare, with: step.with, when: undefined, flow: step.flow ?? "inner/flow.yaml", returns: undefined };
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
