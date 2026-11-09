/** Mesaj kataloğu (02-prd.md "Mesaj kataloğu"). Kullanıcıya giden her metin buradan gelir. */
export interface Message {
  channel: 'watch' | 'phone' | 'family' | 'console' | 'voice';
  text: string;
  action?: string;
}
export type Catalog = Record<string, Message>;
export declare const catalogs: { tr: Catalog } & Record<string, Catalog>;
export declare function t(code: string, lang?: string, vars?: Record<string, string | number>): string;
