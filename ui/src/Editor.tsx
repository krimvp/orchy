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
  follow,
  membersOf,
  operatorOf,
  unsaved,
  useLoad,
} from "./api";
import { type Edge, Graph } from "./Graph";
import { FileIcon, KindIcon, LoopIcon } from "./icons";
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
  const [picked, setPicked] = useState<Edge>();
  /** The step whose loop stands open in the drawer on the right. */
  const [loopOf, setLoopOf] = useState<string>();
  /** The file that stands open in the drawer on the right. */
  const [fileOf, setFileOf] = useState<{ path: string; label: string }>();
  const [problems, setProblems] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [note, setNote] = useState<string>();
  const [fault, setFault] = useState<string>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (loaded.value) {
      setFlow(loaded.value.flow);
      setProblems(loaded.value.problems);
      setWarnings(loaded.value.warnings ?? []);
    }
  }, [loaded.value]);

  /** The flow differs from the file, so leaving without Save loses the change. */
  const dirty = Boolean(flow && loaded.value && JSON.stringify(flow) !== JSON.stringify(loaded.value.flow));

  // A change that never reached the file deserves one word before the tab
  // goes — and the router reads the same flag before a link leaves this page.
  useEffect(() => {
    unsaved.here = dirty;
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", warn);
    return () => {
      unsaved.here = false;
      removeEventListener("beforeunload", warn);
    };
  }, [dirty]);

  // The runner owns the rules, so the editor asks it rather than repeating them.
  useEffect(() => {
    if (!flow) return;
    const timer = setTimeout(() => {
      void api
        .validate(flow, loaded.value?.row.path)
        .then((answer) => {
          setProblems(answer.problems);
          setWarnings(answer.warnings ?? []);
        })
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [flow, loaded.value?.row.path]);


  if (loaded.error) return <p className="bad">{loaded.error}</p>;
  if (!flow || !loaded.value) return <Loading lines={4} />;

  const editable = loaded.value.editable;
  const step = flow.steps.find((one) => one.id === chosen);
  const loopStep = flow.steps.find((one) => one.id === loopOf);

  const change = (stepId: string, patch: Partial<Step>) =>
    setFlow({
      ...flow,
      steps: flow.steps.map((one) => (one.id === stepId ? clean({ ...one, ...patch }) : one)),
    });

  const rename = (from: string, to: string) => {
    setChosen(to);
    if (loopOf === from) setLoopOf(to);
    setFlow({
      ...flow,
      steps: flow.steps.map((one) => ({
        ...(one.id === from ? { ...one, id: to } : one),
        needs: one.needs.map((need) => (need === from ? to : need)),
        ...(one.cycle?.to === from ? { cycle: { ...one.cycle, to } } : {}),
      })),
    });
  };

  const add = (kind: Step["kind"]) => {
    const name = free(flow, kind);
    const seed = { id: name, kind, needs: [] } as unknown as Step;
    const shaped = clean({ ...seed, ...retype(seed, kind) });
    // Each new step gets its own prompt file, so two steps never share one by accident.
    if (kind === "agent") shaped.prompt = `prompts/${name}.md`;
    setFlow({ ...flow, steps: [...flow.steps, shaped] });
    setChosen(name);
  };

  const remove = (stepId: string) => {
    setChosen(undefined);
    setPicked(undefined);
    if (loopOf === stepId) setLoopOf(undefined);
    setFlow({
      ...flow,
      steps: flow.steps
        .filter((one) => one.id !== stepId)
        .map((one) => ({ ...one, needs: one.needs.filter((need) => need !== stepId) })),
    });
  };

  /** The drag drew an arrow from one step to another, so the later one waits. */
  const connect = (from: string, to: string) => {
    const holder = flow.steps.find((one) => one.id === to);
    if (holder && !holder.needs.includes(from)) change(to, { needs: [...holder.needs, from] });
  };

  /** The drag drew a loop, and the drawer opens on it, ready to shape. */
  const loop = (from: string, to: string) => {
    const holder = flow.steps.find((one) => one.id === from);
    change(
      from,
      from === to
        ? { cycle: { to: from, when: "failed", limit: 2, policy: "escalate" } }
        : {
            cycle: {
              to,
              when: holder ? guess(holder) : {},
              limit: 3,
              policy: holder?.kind === "gate" ? "accept" : "escalate",
            },
          },
    );
    setChosen(from);
    setPicked(undefined);
    setFileOf(undefined);
    setLoopOf(from);
  };

  /** Opens the loop of a step on the right, and gives it one to open when it has none. */
  const openLoop = (id: string) => {
    const holder = flow.steps.find((one) => one.id === id);
    if (!holder) return;
    if (!holder.cycle) {
      // A loop goes back, so it aims at the nearest step before this one. A
      // step with nothing before it retries itself instead.
      const backs = before(flow, id);
      const to = backs[backs.length - 1];
      const gate = holder.kind === "gate";
      change(id, {
        cycle: to
          ? { to, when: guess(holder), limit: 3, policy: gate ? "accept" : "escalate" }
          : { to: id, when: "failed", limit: 2, policy: "escalate" },
      });
    }
    setChosen(id);
    setPicked(undefined);
    setFileOf(undefined);
    setLoopOf(id);
  };

  /** Opens a file the flow names. The path in the file is relative to the flow. */
  const openFile = (relativePath: string | undefined, label: string) => {
    if (!relativePath || !loaded.value) return;
    setLoopOf(undefined);
    setPicked(undefined);
    setFileOf({ path: besides(loaded.value.row.path, relativePath), label });
  };

  const unlink = (edge: Edge) => {
    if (edge.kind === "need") {
      const holder = flow.steps.find((one) => one.id === edge.to);
      if (holder) change(edge.to, { needs: holder.needs.filter((need) => need !== edge.from) });
    } else {
      change(edge.from, { cycle: undefined });
      if (loopOf === edge.from) setLoopOf(undefined);
    }
    setPicked(undefined);
  };

  // The flow says what it takes, so the page asks for those values and no others.
  const start = (values?: Record<string, unknown>) =>
    api
      .startFlow(id, values)
      .then((ticket) => {
        setStarting(false);
        setFault(undefined);
        setNote("Starting the run…");
        return follow(ticket);
      })
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message)));

  const save = (): Promise<boolean> =>
    api
      .saveFlow(id, flow)
      .then((answer) => {
        setProblems(answer.problems);
        setNote(answer.saved ? "Saved to the file." : undefined);
        setFault(answer.saved ? undefined : "The flow is not valid, so nothing was written.");
        // The file holds the flow now, so the page reads it back and stands clean.
        if (answer.saved) loaded.again();
        return answer.saved;
      })
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message), false));

  // A run reads the file, not this page — so a run of unsaved work saves first.
  const run = () => {
    const open = () => (flow.takes ? setStarting(true) : void start());
    if (dirty && editable) void save().then((saved) => saved && open());
    else open();
  };

  return (
    <section className="stagger">
      <h1>{flow.name}</h1>
      <p className="note mono small" style={{ "--i": 1 } as CSSProperties}>
        {loaded.value.row.path}
      </p>

      {/* The toolbox: what the flow does, and what a person adds to it. */}
      <div className="bar-actions toolbox" style={{ "--i": 2 } as CSSProperties}>
        <button className="go" disabled={!editable || problems.length > 0 || !dirty} onClick={() => void save()}>
          {dirty ? "Save" : "Saved"}
        </button>
        <button title={dirty && editable ? "A run reads the file, so this saves first." : undefined} onClick={run}>
          {dirty && editable ? "Save and run" : "Run"}
        </button>
        {dirty && (
          <span className="dim small" title="The file still holds the old flow until you save.">
            not saved yet
          </span>
        )}
        {editable && (
          <>
            <span className="rule" />
            <span className="dim small">Add</span>
            {KINDS.map((kind) => (
              <button key={kind} className="tool" title={`Add a ${kind} step`} onClick={() => add(kind)}>
                <KindIcon kind={kind} />
                {kind}
              </button>
            ))}
            <span className="rule" />
            <button
              className="tool"
              disabled={!step}
              title={step ? `Draw a loop on ${step.id}` : "Choose a step in the drawing first"}
              onClick={() => step && openLoop(step.id)}
            >
              <LoopIcon />
              loop
            </button>
          </>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {problems.length === 0 && warnings.length > 0 && (
            <span className="pill waiting" title={warnings.join("\n")}>
              {warnings.length} missing file{warnings.length === 1 ? "" : "s"}
            </span>
          )}
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
      {/* A missing file blocks no save — the file drawer writes it in one click —
          but a run would spend money on it, so it stands here in plain sight. */}
      {problems.length === 0 && warnings.length > 0 && (
        <ul className="warn list">
          {warnings.map((warning) => (
            <li key={warning}>{warning} — open it from its step and save it.</li>
          ))}
        </ul>
      )}

      <div className="canvas" style={{ "--i": 3 } as CSSProperties}>
        <Graph
          steps={flow.steps}
          selected={chosen}
          onSelect={(one) => {
            setChosen(one);
            setPicked(undefined);
          }}
          editable={editable}
          picked={picked ?? held(flow, loopOf)}
          onConnect={connect}
          onCycle={loop}
          onPickEdge={(edge) => (edge.kind === "cycle" ? openLoop(edge.from) : setPicked(edge))}
        />
        {picked && (
          <div className="edge-bar">
            <span>
              <b>{picked.to}</b> waits for <b>{picked.from}</b>.
            </span>
            <button className="danger" onClick={() => unlink(picked)}>
              Remove this link
            </button>
            <button className="quiet" onClick={() => setPicked(undefined)}>
              Close
            </button>
          </div>
        )}
        {editable && !picked && (
          <p className="hint small">
            Drag a step's right dot onto another to link them, and the lower dot to draw a loop — onto itself, to
            retry. Click a loop to open it, and a link to cut it.
          </p>
        )}
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
            <label className="field" title="How many steps of this flow may run at the same time.">
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
              {flow.budget === undefined && (
                <span className="warn small">
                  Without a budget, a run can spend without limit. A run stops before the step that would pass it.
                </span>
              )}
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
                Choose a step in the drawing, or add one above it.
              </p>
            </div>
          )}
          {step && (
            <StepFields
              // The key is the place of the step, not its id: a rename keeps
              // the panel mounted, so the Id field keeps focus while a person
              // types. An id key remounted it every keystroke and ate them.
              key={flow.steps.indexOf(step)}
              flow={flow}
              step={step}
              tools={health.value?.tools ?? []}
              adapters={health.value?.adapters ?? []}
              operators={health.value?.operators ?? []}
              models={health.value?.models ?? {}}
              onChange={(patch) => change(step.id, patch)}
              onRename={(to) => rename(step.id, to)}
              onRemove={() => remove(step.id)}
              onLoop={() => openLoop(step.id)}
              onOpenFile={openFile}
            />
          )}
        </div>
      </div>

      {loopStep?.cycle && (
        <LoopDrawer
          flow={flow}
          step={loopStep}
          operators={health.value?.operators ?? []}
          onChange={(patch) => change(loopStep.id, patch)}
          onRemove={() => {
            change(loopStep.id, { cycle: undefined });
            setLoopOf(undefined);
          }}
          onClose={() => setLoopOf(undefined)}
        />
      )}

      {fileOf && <FileDrawer path={fileOf.path} label={fileOf.label} onClose={() => setFileOf(undefined)} />}
    </section>
  );
}

/** The path of a file a flow names, which is relative to the flow file. */
function besides(flowPath: string, relativePath: string): string {
  return flowPath.replace(/[^/\\]+$/, "") + relativePath.replace(/^\.\//, "");
}

/** The loop that stands open in the drawer, as the edge the drawing marks. */
function held(flow: Flow, loopOf?: string): Edge | undefined {
  const step = flow.steps.find((one) => one.id === loopOf);
  return step?.cycle ? { kind: "cycle", from: step.id, to: step.cycle.to } : undefined;
}

/** The steps before this one: everything it waits for, however far back. */
function before(flow: Flow, id: string): string[] {
  const seen = new Set<string>();
  const walk = (one: string) => {
    for (const need of flow.steps.find((step) => step.id === one)?.needs ?? []) {
      if (!seen.has(need)) {
        seen.add(need);
        walk(need);
      }
    }
  };
  walk(id);
  return flow.steps.filter((one) => seen.has(one.id)).map((one) => one.id);
}

/**
 * The condition a new loop most often wants: the first yes-or-no field of the
 * contract, false. A reviewer approves or it does not, so this guess lands
 * more often than an empty match that always fires.
 */
function guess(step: Step): Cycle["when"] {
  const properties = step.returns?.properties as Record<string, Schema> | undefined;
  const key = properties && Object.entries(properties).find(([, field]) => field.type === "boolean")?.[0];
  return key ? { [key]: false } : {};
}

function StepFields({
  flow,
  step,
  tools,
  adapters,
  operators,
  models,
  onChange,
  onRename,
  onRemove,
  onLoop,
  onOpenFile,
}: {
  flow: Flow;
  step: Step;
  tools: string[];
  adapters: string[];
  operators: Operator[];
  models: Record<string, string>;
  onChange: (patch: Partial<Step>) => void;
  onRename: (to: string) => void;
  onRemove: () => void;
  onLoop: () => void;
  onOpenFile: (relativePath: string | undefined, label: string) => void;
}) {
  const others = flow.steps.filter((one) => one.id !== step.id);
  // The hint of the harness this step runs under: its own, or the flow's.
  const modelHint = models[step.harness ?? flow.harness ?? ""] ?? "the harness chooses";
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
        <span>Runs after</span>
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
          <div className="field">
            <span>Prompt</span>
            <div className="with-open">
              <input value={step.prompt ?? ""} onChange={(e) => onChange({ prompt: e.target.value })} />
              <button className="quiet" title="Open the prompt" onClick={() => onOpenFile(step.prompt, "prompt")}>
                <FileIcon />
              </button>
            </div>
          </div>
          <label className="field" title="The harness is the agent program that runs this step.">
            <span>Harness</span>
            <select value={step.harness ?? ""} onChange={(e) => onChange({ harness: e.target.value || undefined })}>
              <option value="">the default of the run</option>
              {adapters.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="field" title={modelHint}>
            <span>Model</span>
            <input
              placeholder={modelHint}
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
        <div className="field">
          <span>Module</span>
          <div className="with-open">
            <input value={step.module ?? ""} onChange={(e) => onChange({ module: e.target.value })} />
            <button className="quiet" title="Open the module" onClick={() => onOpenFile(step.module, "module")}>
              <FileIcon />
            </button>
          </div>
        </div>
      )}

      {step.kind === "gate" && (
        <label className="field">
          <span>Question</span>
          <textarea rows={2} value={step.question ?? ""} onChange={(e) => onChange({ question: e.target.value })} />
        </label>
      )}

      {step.kind === "flow" && (
        <div className="field">
          <span>Flow file</span>
          <div className="with-open">
            <input value={step.flow ?? ""} onChange={(e) => onChange({ flow: e.target.value })} />
            <button className="quiet" title="Open the inner flow" onClick={() => onOpenFile(step.flow, "inner flow")}>
              <FileIcon />
            </button>
          </div>
        </div>
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
        <SchemaFields
          title="Returns a value under this contract"
          schema={step.returns}
          onChange={(returns) => onChange({ returns })}
        />
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

      {/* The loop reads as its sentence here, and the drawer on the right shapes it. */}
      <div className="field set">
        <span>Loop</span>
        {step.cycle ? (
          <>
            <p className="sentence">{tale(step, step.cycle)}</p>
            <div className="row" style={{ margin: "10px 0 0" }}>
              <button className="quiet" onClick={onLoop}>
                Edit the loop
              </button>
            </div>
          </>
        ) : (
          <button className="quiet" onClick={onLoop}>
            Add a loop
          </button>
        )}
      </div>

      {(step.kind === "agent" || step.kind === "call") && (
        <FanoutFields step={step} onChange={onChange} onOpenFile={onOpenFile} />
      )}

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

/** What one field of a contract can be, in the words a person would use. */
type FieldKind = "text" | "number" | "boolean" | "list" | "custom";

const SHAPES: Record<Exclude<FieldKind, "custom">, Schema> = {
  text: { type: "string" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  list: { type: "array", items: { type: "string" } },
};

const KIND_WORDS: Array<{ value: FieldKind; label: string }> = [
  { value: "text", label: "text" },
  { value: "number", label: "a number" },
  { value: "boolean", label: "yes or no" },
  { value: "list", label: "a list of text" },
];

function fieldKind(field: Schema): FieldKind {
  for (const [kind, shape] of Object.entries(SHAPES)) {
    if (JSON.stringify(field) === JSON.stringify(shape)) return kind as FieldKind;
  }
  if (JSON.stringify(field) === JSON.stringify({ type: "integer" })) return "number";
  return "custom";
}

/**
 * The rows of a plain object schema, or nothing when the schema holds a shape
 * the rows cannot say. The rows never drop what they cannot draw: a field with
 * an enum or a nested object stays as it is, and only JSON edits it.
 */
function plainRows(schema: Schema): { fields: Array<[string, Schema]>; required: string[] } | undefined {
  if (schema.type !== "object") return undefined;
  if (!Object.keys(schema).every((key) => ["type", "required", "properties"].includes(key))) return undefined;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  if (typeof properties !== "object" || Array.isArray(properties) || !Array.isArray(required)) return undefined;
  return { fields: Object.entries(properties as Record<string, Schema>), required: required as string[] };
}

/**
 * A contract as a list of fields: a name, what it is, and whether it must come
 * back. This is the whole schema for most contracts, and JSON stays one click
 * away for the rest.
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
  const [asJson, setAsJson] = useState(false);
  const rows = schema && plainRows(schema);

  const write = (fields: Array<[string, Schema]>, required: string[]) =>
    onChange({
      type: "object",
      required: required.filter((key) => fields.some(([name]) => name === key)),
      properties: Object.fromEntries(fields),
    });

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
      {schema && (!rows || asJson) && (
        <div style={{ marginTop: 14 }}>
          <Json value={schema} onChange={(value) => onChange(value as Schema)} rows={7} />
          {rows ? (
            <button className="quiet" onClick={() => setAsJson(false)}>
              Draw the fields
            </button>
          ) : (
            <span className="note small">
              This contract holds a shape the rows cannot say, so the editor keeps it as JSON Schema.
            </span>
          )}
        </div>
      )}
      {schema && rows && !asJson && (
        <div style={{ marginTop: 14 }}>
          {rows.fields.map(([name, field], index) => {
            const kind = fieldKind(field);
            const at = (nextName: string, nextField: Schema) =>
              write(
                rows.fields.map((one, place) => (place === index ? [nextName, nextField] : one)),
                rows.required.map((key) => (key === name ? nextName : key)),
              );
            return (
              <div key={index} className="member">
                <input
                  placeholder="name"
                  value={name}
                  onChange={(e) => at(e.target.value, field)}
                />
                {kind === "custom" ? (
                  <span className="mono small held" title={JSON.stringify(field)}>
                    as written
                  </span>
                ) : (
                  <select
                    value={kind}
                    onChange={(e) => at(name, SHAPES[e.target.value as Exclude<FieldKind, "custom">])}
                  >
                    {KIND_WORDS.map((one) => (
                      <option key={one.value} value={one.value}>
                        {one.label}
                      </option>
                    ))}
                  </select>
                )}
                <label className="tick" title="The value must hold this field">
                  <input
                    type="checkbox"
                    checked={rows.required.includes(name)}
                    onChange={(e) =>
                      write(
                        rows.fields,
                        e.target.checked ? [...rows.required, name] : rows.required.filter((key) => key !== name),
                      )
                    }
                  />
                  <span>needed</span>
                </label>
                <button
                  className="quiet"
                  onClick={() =>
                    write(
                      rows.fields.filter((_one, place) => place !== index),
                      rows.required,
                    )
                  }
                >
                  Remove
                </button>
              </div>
            );
          })}
          <button
            className="quiet"
            onClick={() => write([...rows.fields, [freeKey(rows.fields), { type: "string" }]], rows.required)}
          >
            Add a field
          </button>
          <button className="quiet" onClick={() => setAsJson(true)}>
            Write it as JSON
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The loop of a step, in a drawer on the right. The sentence stands first and
 * says what the loop will do; the fields below it write the sentence. The
 * drawer opens from a loop in the drawing, from a drag that draws one, and
 * from the step panel.
 */
function LoopDrawer({
  flow,
  step,
  operators,
  onChange,
  onRemove,
  onClose,
}: {
  flow: Flow;
  step: Step;
  operators: Operator[];
  onChange: (patch: Partial<Step>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  // A loop goes back, so the choice is the steps before this one — and the
  // step itself, which reads as a retry. A target outside that set still
  // shows, so the drawer never hides what the file says.
  const backs = before(flow, step.id);
  const cycle = step.cycle;
  const gate = step.kind === "gate";

  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);

  if (!cycle) return null;
  const targets = [...backs, ...(backs.includes(cycle.to) || cycle.to === step.id ? [] : [cycle.to])];

  return (
    <aside className="drawer">
      <header>
        <h3>The loop of {step.id}</h3>
        <button className="quiet" onClick={onClose}>
          Close
        </button>
      </header>

      <p className="sentence">{tale(step, cycle)}</p>

      {/* A gate cannot fail, so its loop reads the answer and nothing else. */}
      {!gate && (
        <div className="field">
          <span>The loop fires</span>
          <Segmented
            value={cycle.when === "failed" ? "failed" : "value"}
            options={[
              { value: "value", label: "when the answer matches" },
              { value: "failed", label: "when this step fails" },
            ]}
            onChange={(kind) =>
              onChange({
                cycle:
                  kind === "failed"
                    ? { ...cycle, when: "failed", to: step.id, policy: "escalate" }
                    : { ...cycle, when: guess(step), to: backs[backs.length - 1] ?? step.id },
              })
            }
          />
          {cycle.when === "failed" && (
            <span className="note small">
              A step that fails retries itself and hears its own error, so it does not repeat the mistake.
            </span>
          )}
        </div>
      )}
      {cycle.when !== "failed" && (
        <>
          <label className="field">
            <span>The run goes back to</span>
            <select value={cycle.to} onChange={(e) => onChange({ cycle: { ...cycle, to: e.target.value } })}>
              {targets.map((one) => (
                <option key={one}>{one}</option>
              ))}
              <option value={step.id}>{step.id} — itself, a retry</option>
            </select>
          </label>
          <div className="field">
            <span>When the answer of this step matches</span>
            {/* A cycle reads the value of the step it sits on. See ADR 0016. */}
            <MatchFields
              match={cycle.when}
              keys={keysOf(step)}
              operators={operators}
              onChange={(when) => onChange({ cycle: { ...cycle, when } })}
            />
          </div>
        </>
      )}
      <label className="field">
        <span>At most, before the run settles it</span>
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
          options={
            gate
              ? // A gate refuses escalate: an escalation asks a person for a
                // value that a person just gave.
                [{ value: "accept" as Cycle["policy"], label: "the run accepts the answer" }]
              : cycle.when === "failed"
                ? [
                    { value: "escalate" as Cycle["policy"], label: "a person takes over" },
                    // A failure carries no value, so there is nothing to accept.
                    { value: "accept" as Cycle["policy"], label: "the run fails" },
                  ]
                : [
                    { value: "escalate" as Cycle["policy"], label: "a person takes over" },
                    { value: "accept" as Cycle["policy"], label: "the run accepts the answer" },
                  ]
          }
          onChange={(policy) => onChange({ cycle: { ...cycle, policy } })}
        />
      </div>

      <div className="row" style={{ marginBottom: 0 }}>
        <button className="danger" onClick={onRemove}>
          Remove the loop
        </button>
      </div>
    </aside>
  );
}

/**
 * A file the flow names, open on the right. The person reads it, writes it,
 * and saves it, without leaving the flow. A path with no file yet is a file
 * this drawer creates, so a new step gets its prompt in the same motion.
 */
function FileDrawer({ path, label, onClose }: { path: string; label: string; onClose: () => void }) {
  const loaded = useLoad(() => api.file(path), [path]);
  const [text, setText] = useState<string>();
  const [note, setNote] = useState<string>();
  const [fault, setFault] = useState<string>();

  useEffect(() => {
    if (loaded.value) setText(loaded.value.content);
  }, [loaded.value]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);

  const save = () =>
    api
      .writeFile(path, text ?? "")
      .then(() => (setFault(undefined), setNote("Saved to the file.")))
      .catch((problem: Error) => (setNote(undefined), setFault(problem.message)));

  return (
    <aside className="drawer file">
      <header>
        <h3>The {label}</h3>
        <button className="quiet" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="note mono small" style={{ margin: "0 0 12px" }}>
        {path}
      </p>
      {loaded.error && <p className="bad">{loaded.error}</p>}
      {loaded.value && !loaded.value.exists && (
        <p className="note small" style={{ margin: "0 0 10px" }}>
          There is no file here yet. Save writes it, with the directories on the way.
        </p>
      )}
      {!loaded.value && !loaded.error && <div className="skeleton" />}
      {text !== undefined && (
        <>
          <textarea
            className="file-text"
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setNote(undefined);
            }}
          />
          <div className="row" style={{ marginBottom: 0 }}>
            <button className="go" onClick={() => void save()}>
              Save the file
            </button>
            {note && <span className="good small">{note}</span>}
            {fault && <span className="bad small">{fault}</span>}
          </div>
        </>
      )}
    </aside>
  );
}

/** The loop, read back as the one sentence it will act out. */
function tale(step: Step, cycle: Cycle): string {
  const times = (count: number) => `${count} ${count === 1 ? "time" : "times"}`;
  if (cycle.when === "failed") {
    const end = cycle.policy === "escalate" ? "a person is asked for the value" : "the run fails";
    return `When ${step.id} fails, it tries again and hears its error, at most ${times(cycle.limit)}. If it still fails, ${end}.`;
  }
  const to = cycle.to === step.id ? "runs again" : `goes back to ${cycle.to}`;
  const match = Object.keys(cycle.when).length === 0 ? "always" : `matches ${JSON.stringify(cycle.when)}`;
  const end =
    cycle.policy === "escalate" ? "a person is asked for the value" : "the run accepts the answer and moves on";
  return `When the answer of ${step.id} ${match === "always" ? "arrives" : match}, the run ${to}, at most ${times(cycle.limit)}. At the limit, ${end}.`;
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
  const rows =
    held &&
    Object.entries(held).map(([key, value]) => ({
      key,
      held: operatorOf(value, operators) ?? plainIs(value, operators),
    }));
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
          // The key is the place of the row: a renamed key keeps its input mounted.
          <div key={index} className="member">
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

/**
 * A bare value in a match tests equality, so the row draws it as `is`. The
 * row that edits it writes the operator out, which says the same thing.
 */
function plainIs(wanted: unknown, operators: Operator[]): [Operator, unknown] | undefined {
  if (typeof wanted === "object" && wanted !== null) return undefined;
  const is = operators.find((one) => one.name === "is");
  return is && [is, wanted];
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

function FanoutFields({
  step,
  onChange,
  onOpenFile,
}: {
  step: Step;
  onChange: (patch: Partial<Step>) => void;
  onOpenFile: (relativePath: string | undefined, label: string) => void;
}) {
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
              {/* A member that names its own file opens it. The rest read the step's. */}
              {(step.kind === "call" ? member.module : member.prompt) && (
                <button
                  className="quiet"
                  title={`Open ${step.kind === "call" ? member.module : member.prompt}`}
                  onClick={() =>
                    step.kind === "call"
                      ? onOpenFile(member.module, `module of ${member.name}`)
                      : onOpenFile(member.prompt, `prompt of ${member.name}`)
                  }
                >
                  <FileIcon />
                </button>
              )}
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

/** A name that no field of the contract holds yet. */
function freeKey(fields: Array<[string, Schema]>): string {
  let name = "field";
  let count = 1;
  while (fields.some(([one]) => one === name)) name = `field-${++count}`;
  return name;
}

function next(members: Member[]): string {
  let count = members.length + 1;
  while (members.some((one) => one.name === `one-${count}`)) count += 1;
  return `one-${count}`;
}
