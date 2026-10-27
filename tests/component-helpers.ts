import { ComponentType } from 'discord.js';

export interface ComponentNode {
  type: ComponentType;
  custom_id?: string;
  style?: number;
  disabled?: boolean;
  label?: string;
  description?: string;
  content?: string;
  url?: string;
  options?: { label: string; value: string; description?: string }[];
  components?: ComponentNode[];
  component?: ComponentNode;
  accessory?: ComponentNode;
}
// Serializing exercises discord.js builder validation, including nested V2 components.
export function nodes(payload: unknown): ComponentNode[] {
  const result: ComponentNode[] = [];
  function walk(value: ComponentNode) {
    result.push(value);
    for (const child of value.components || []) walk(child);
    if (value.component) walk(value.component);
    if (value.accessory) walk(value.accessory);
  }
  const json = JSON.parse(JSON.stringify(payload)) as { components: ComponentNode[] };
  for (const component of json.components) walk(component);
  return result;
}
export const controls = (payload: unknown) => nodes(payload).filter((n) => n.custom_id);
export function select(payload: unknown) {
  const s = nodes(payload).find((n) => n.type === ComponentType.StringSelect);
  if (!s?.options) throw new Error('Expected a game/request select menu');
  return s.options;
}
export function actionId(payload: unknown, action: string): string {
  const id = controls(payload).find((n) => n.custom_id?.startsWith(`nx:${action}:`))?.custom_id;
  if (!id) throw new Error(`Missing ${action} control`);
  return id;
}
