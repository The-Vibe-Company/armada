/**
 * The launch model picker (#1483): the agent's own models, then the models of every usable connection of that
 * agent, grouped by connection, searchable, the default marked and the price per million tokens when known.
 * A connection model's select value also names its account, so choosing it chooses who is billed.
 */
import type { ConnectionModelInfo, HarnessModels } from "@armada/core";
import { modelPrice } from "@armada/core";

/** A model a connection declares, offered under that connection's name. */
export interface ConnectionChoices {
  accountId: string;
  /** What the account select shows: the account name, with its org for an org account. */
  label: string;
  models: readonly ConnectionModelInfo[];
}

export interface PickerOption {
  /** The select value: a bare model ID, or a connection model encoded with its account. */
  value: string;
  model: string;
  label: string;
  /** "$2 in · $10 out per M tokens", or null when unknown. */
  price: string | null;
  isDefault: boolean;
}

export interface PickerGroup {
  label: string;
  accountId: string | null;
  options: PickerOption[];
}

const PREFIX = "connection:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function connectionValue(accountId: string, model: string): string {
  return `${PREFIX}${accountId}:${model}`;
}

/** The model a select value runs, and the account it names when it is a connection model. */
export function decodeModelValue(value: string): { model: string; accountId: string | null } {
  if (!value.startsWith(PREFIX)) return { model: value, accountId: null };
  const rest = value.slice(PREFIX.length);
  const accountId = rest.slice(0, 36);
  if (!UUID.test(accountId) || rest[36] !== ":") return { model: value, accountId: null };
  return { model: rest.slice(37), accountId };
}

export function priceText(input: number | string | null, output: number | string | null): string | null {
  if (input === null || output === null) return null;
  return `$${input} in · $${output} out per M tokens`;
}

export function pickerGroups(
  agentLabel: string,
  entry: HarnessModels,
  connections: readonly ConnectionChoices[],
): PickerGroup[] {
  const own: PickerGroup = {
    label: `${agentLabel} models`,
    accountId: null,
    options: entry.models.map((option) => {
      const price = modelPrice(option.id);
      return {
        value: option.id,
        model: option.id,
        label: option.label,
        price: price ? priceText(price.input, price.output) : null,
        isDefault: option.id === entry.defaultModel,
      };
    }),
  };
  return [
    own,
    ...connections
      .filter((connection) => connection.models.length > 0)
      .map((connection) => ({
        label: connection.label,
        accountId: connection.accountId,
        options: connection.models.map((info) => ({
          value: connectionValue(connection.accountId, info.model),
          model: info.model,
          label: info.model,
          price: priceText(info.input, info.output),
          isDefault: false,
        })),
      })),
  ];
}

/** Groups whose options match every word of the query (model, label or connection); the kept value always stays. */
export function filterPicker(groups: readonly PickerGroup[], query: string, keep: string): PickerGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...groups];
  return groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) => {
        if (option.value === keep) return true;
        const text = `${option.model} ${option.label} ${group.label}`.toLowerCase();
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((group) => group.options.length > 0);
}

/**
 * The model to select after the billing account changes: the new account's first declared model when it declares
 * any; otherwise the agent's default in place of another connection's model; otherwise the current choice.
 */
export function modelForAccount(
  current: string,
  account: string | undefined,
  connections: readonly ConnectionChoices[] | undefined,
  defaultModel: string,
): string {
  const declared = connections?.find((connection) => connection.accountId === account)?.models[0];
  if (declared && account) {
    return decodeModelValue(current).accountId === account ? current : connectionValue(account, declared.model);
  }
  return decodeModelValue(current).accountId ? defaultModel : current;
}

/** "Models: a, b and 3 more", the declared models an account row names. */
export function connectionModelsNote(models: readonly string[], shown = 3): string {
  const listed = models.slice(0, shown).join(", ");
  const rest = models.length - shown;
  return `Models: ${listed}${rest > 0 ? ` and ${rest} more` : ""}`;
}
