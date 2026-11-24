// Scripted CdpPage (§8.15a): nodes are declared with the exact selector strings
// and roles the drivers query. Every input call is recorded so tests can
// assert "clicked exactly once", "no navigation while waiting", and so on.
import { NodeNotClickable } from '../../../apps/connector-desktop/src/drivers/cdp-page.ts';
import type { CdpPage, Modifier, NodeRef, ResponseWatcher, WatchedResponse } from '../../../apps/connector-desktop/src/drivers/types.ts';

export interface FakeNode {
  id: number; css?: string[]; role?: string; name?: string; text?: string; attrs?: Record<string, string | null>;
  visible?: boolean; parent?: number; onClick?(): void; onFiles?(paths: string[]): void;
}
export interface FakeCall { method: string; node?: number; args?: unknown[] }

export class FakeCdpPage implements CdpPage {
  nodes: FakeNode[] = [];
  url_ = 'about:blank';
  body = '';
  frames: string[] = [];
  calls: FakeCall[] = [];
  responses: WatchedResponse[] = [];
  focused?: number;
  onGoto?: (url: string, page: FakeCdpPage) => void;
  onInsert?: (text: string, page: FakeCdpPage) => void;
  onPress?: (key: string, page: FakeCdpPage) => void;
  #next = 1;

  add(node: Omit<FakeNode, 'id'>): FakeNode { const full = { ...node, id: this.#next++ }; this.nodes.push(full); return full; }
  remove(predicate: (node: FakeNode) => boolean) { this.nodes = this.nodes.filter(node => !predicate(node)); }
  find(id: number) { return this.nodes.find(node => node.id === id); }
  count(method: string, node?: number) { return this.calls.filter(call => call.method === method && (node === undefined || call.node === node)).length; }
  /** Calls that change what the page shows: navigation and reloads. */
  navigations() { return this.calls.filter(call => call.method === 'goto'); }

  #ref(node: FakeNode): NodeRef { return { backendNodeId: node.id, name: node.name, disabled: node.attrs?.['aria-disabled'] === 'true' }; }
  #inside(node: FakeNode, within?: NodeRef) {
    if (!within) return true;
    for (let current: FakeNode | undefined = node; current; current = current.parent ? this.find(current.parent) : undefined) {
      if (current.parent === within.backendNodeId) return true;
    }
    return false;
  }

  async goto(url: string) { this.calls.push({ method: 'goto', args: [url] }); this.url_ = url; this.onGoto?.(url, this); return this.url_; }
  async url() { return this.url_; }
  async queryCss(selector: string, options: { within?: NodeRef; visible?: boolean; text?: RegExp } = {}) {
    return this.nodes.filter(node => node.css?.includes(selector) && this.#inside(node, options.within) && (options.visible === false || node.visible !== false)
      && (!options.text || options.text.test(node.text ?? ''))).map(node => this.#ref(node));
  }
  async queryRole(role: string, name: RegExp, options: { within?: NodeRef } = {}) {
    return this.nodes.filter(node => node.role === role && name.test(node.name ?? '') && this.#inside(node, options.within) && node.visible !== false).map(node => this.#ref(node));
  }
  async clickable(node: NodeRef) { const target = this.find(node.backendNodeId); return !!target && target.attrs?.['aria-disabled'] !== 'true'; }
  async click(node: NodeRef) {
    const target = this.find(node.backendNodeId);
    if (!target) throw new NodeNotClickable('detached');
    if (target.attrs?.['aria-disabled'] === 'true') throw new NodeNotClickable('disabled');
    this.calls.push({ method: 'click', node: target.id });
    this.focused = target.id;
    target.onClick?.();
  }
  async focus(node: NodeRef) { this.calls.push({ method: 'focus', node: node.backendNodeId }); this.focused = node.backendNodeId; }
  async insertText(text: string) {
    this.calls.push({ method: 'insertText', args: [text] });
    if (this.onInsert) this.onInsert(text, this);
    else { const target = this.focused !== undefined ? this.find(this.focused) : undefined; if (target) target.text = (target.text ?? '') + text; }
  }
  async press(key: string, modifiers: Modifier[] = []) {
    this.calls.push({ method: 'press', args: [key, modifiers] });
    if (this.onPress) { this.onPress(key, this); return; }
    const target = this.focused !== undefined ? this.find(this.focused) : undefined;
    if (!target) return;
    if (key === 'Enter') target.text = (target.text ?? '') + '\n';
    else if (key === ' ') target.text = (target.text ?? '') + ' ';
    else if (key === 'Backspace') {
      target.text = modifiers.length || target.attrs?.selected === 'all' ? '' : (target.text ?? '').slice(0, -1);
      if (target.attrs?.selected) target.attrs = { ...target.attrs, selected: null };
    }
    else if (key === 'a' && modifiers.length) { /* select all: the next Backspace clears */ target.attrs = { ...target.attrs, selected: 'all' }; }
  }
  async typeChars(text: string) { this.calls.push({ method: 'typeChars', args: [text] }); const target = this.focused !== undefined ? this.find(this.focused) : undefined; if (target) target.text = (target.text ?? '') + text; }
  async setFiles(node: NodeRef, paths: string[]) { this.calls.push({ method: 'setFiles', node: node.backendNodeId, args: [paths] }); this.find(node.backendNodeId)?.onFiles?.(paths); }
  async innerText(node: NodeRef) { return this.find(node.backendNodeId)?.text ?? ''; }
  async attribute(node: NodeRef, name: string) { const value = this.find(node.backendNodeId)?.attrs?.[name]; return value === undefined ? null : value; }
  async bodyText() { return this.body; }
  async frameSources() { return [...this.frames]; }
  async screenshot() { this.calls.push({ method: 'screenshot' }); return Buffer.from(`shot-${this.calls.length}`); }
  /** Like CDP: a stopped watcher sees nothing that arrives afterwards (WA-10: a wait must not outlive its watcher). */
  watchResponses(pattern: RegExp): ResponseWatcher {
    let stoppedAt: number | undefined;
    const seen = () => this.responses.slice(0, stoppedAt ?? this.responses.length).filter(item => pattern.test(item.url));
    return {
      responses: seen,
      next: async match => seen().find(match) ?? null,
      stop: () => { stoppedAt ??= this.responses.length; },
    };
  }
  async axSnapshotHash() { return 'fake-ax-hash'; }
  async bringToFront() { this.calls.push({ method: 'bringToFront' }); }
  async close() { this.calls.push({ method: 'close' }); }
}
