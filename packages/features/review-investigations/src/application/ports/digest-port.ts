export interface InvestigationDigestPort {
  digestUtf8(value: string): Promise<string>;
}
