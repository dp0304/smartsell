import { useSyncExternalStore } from 'react';

// Developer mode shows raw API surfaces (endpoint lists, request paths, JSON payloads, the compatibility
// workbench). Operators never need them, so they stay hidden unless someone turns the mode on.
const developerKey = 'smartsell.developer';
const listeners = new Set<() => void>();

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* Storage may be unavailable in private windows. */ }
  for (const listener of listeners) listener();
}

// `?dev=1` turns the mode on for this browser so links shared between developers keep working.
if (typeof window !== 'undefined') {
  const flag = new URLSearchParams(window.location.search).get('dev');
  if (flag === '1') write(developerKey, '1');
  if (flag === '0') write(developerKey, null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === developerKey) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

export function isDeveloperMode() {
  return read(developerKey) === '1';
}

export function setDeveloperMode(enabled: boolean) {
  write(developerKey, enabled ? '1' : null);
}

export function useDeveloperMode() {
  return useSyncExternalStore(subscribe, isDeveloperMode, () => false);
}

/** Remembers small layout choices, such as a collapsed sidebar section. */
export function usePreference(key: string, fallback: string) {
  const value = useSyncExternalStore(subscribe, () => read(`smartsell.ui.${key}`) ?? fallback, () => fallback);
  return [value, (next: string) => write(`smartsell.ui.${key}`, next)] as const;
}

// Phase 1 shows only the core dashboard modules (today, calendar, machines, channels, Agent, settings). The others keep their
// routes and code; Settings → 介面 → 顯示其他模組 brings them back into the navigation for this browser (§9.1).
const moreModulesKey = 'smartsell.ui.more-modules';
export const showsMoreModules = () => read(moreModulesKey) === '1';
export function setShowMoreModules(enabled: boolean) { write(moreModulesKey, enabled ? '1' : null); }
export function useShowMoreModules() {
  return useSyncExternalStore(subscribe, showsMoreModules, () => false);
}
