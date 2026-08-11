import type { SVGProps } from "react";
import type { Step } from "./api";

/**
 * The icon set of the editor: one stroke, one weight, drawn here and nowhere
 * else. Each icon is an <svg>, so it stands in HTML and inside the drawing
 * alike, and it takes its colour from the text around it.
 */
interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
  /** The stroke width, in the 16-unit space of the icon. */
  weight?: number;
}

function Icon({ size = 15, weight = 1.6, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** An agent step: a model does the work. */
export function AgentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 1.8 9.6 6.4 14.2 8 9.6 9.6 8 14.2 6.4 9.6 1.8 8 6.4 6.4 Z" />
    </Icon>
  );
}

/** A call step: a module of code. */
export function CallIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 4.5 2 8l3.5 3.5" />
      <path d="M10.5 4.5 14 8l-3.5 3.5" />
    </Icon>
  );
}

/** A gate: a person answers. */
export function GateIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="5" r="2.6" />
      <path d="M2.8 13.8c0-3.2 2.2-4.8 5.2-4.8s5.2 1.6 5.2 4.8" />
    </Icon>
  );
}

/** A flow step: the steps of another file, in its place. */
export function FlowIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.5" y="1.5" width="6" height="5" rx="1" />
      <rect x="8.5" y="9.5" width="6" height="5" rx="1" />
      <path d="M7.5 4h4v5.5" />
    </Icon>
  );
}

/** A loop: the run goes back. */
export function LoopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.7 10a6 6 0 1 1-1.4-6.2l3 2.9" />
      <path d="M15.3 2.7v4h-4" />
    </Icon>
  );
}

/** A file a flow names: a prompt, a module, an inner flow. */
export function FileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 1.5h6l3 3v10h-9Z" />
      <path d="M9.5 1.5v3h3" />
    </Icon>
  );
}

/** A link: the later step waits for the earlier one. */
export function ArrowIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 8h11" />
      <path d="M9.5 4.5 14 8l-4.5 3.5" />
    </Icon>
  );
}

/** The icon of a step kind, so every surface draws the same one. */
export function KindIcon({ kind, ...props }: IconProps & { kind: Step["kind"] }) {
  if (kind === "agent") return <AgentIcon {...props} />;
  if (kind === "call") return <CallIcon {...props} />;
  if (kind === "gate") return <GateIcon {...props} />;
  return <FlowIcon {...props} />;
}
