import { z } from "zod";

const opaqueIdSchema = z.string().trim().min(1).max(160);

declare const identifierBrand: unique symbol;
type Identifier<Name extends string> = string & {
  readonly [identifierBrand]: Name;
};

export type WorkspaceId = Identifier<"WorkspaceId">;
export type HostedPoolId = Identifier<"HostedPoolId">;
export type HostedAccountId = Identifier<"HostedAccountId">;
export type HostedBindingId = Identifier<"HostedBindingId">;
export type RepositoryId = Identifier<"RepositoryId">;
export type InvocationId = Identifier<"InvocationId">;
export type InvocationGrantId = Identifier<"InvocationGrantId">;
export type RelayRequestId = Identifier<"RelayRequestId">;

function parseId<Name extends string>(value: string): Identifier<Name> {
  return opaqueIdSchema.parse(value) as Identifier<Name>;
}

export const workspaceId = (value: string): WorkspaceId =>
  parseId<"WorkspaceId">(value);
export const hostedPoolId = (value: string): HostedPoolId =>
  parseId<"HostedPoolId">(value);
export const hostedAccountId = (value: string): HostedAccountId =>
  parseId<"HostedAccountId">(value);
export const hostedBindingId = (value: string): HostedBindingId =>
  parseId<"HostedBindingId">(value);
export const repositoryId = (value: string): RepositoryId =>
  parseId<"RepositoryId">(value);
export const invocationId = (value: string): InvocationId =>
  parseId<"InvocationId">(value);
export const invocationGrantId = (value: string): InvocationGrantId =>
  parseId<"InvocationGrantId">(value);
export const relayRequestId = (value: string): RelayRequestId =>
  parseId<"RelayRequestId">(value);
