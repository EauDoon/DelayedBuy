const paths = {
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  diagonal: '<path d="M6 18 18 6M6 6h12v12"/>',
  back: '<path d="M20 12H5m6 6-6-6 6-6"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  box: '<path d="m3 8 9-5 9 5v9l-9 5-9-5zM3 8l9 5 9-5m-9 5v9M7.5 5.5l9 5"/>',
  hourglass: '<path d="M5 3h14M5 21h14M7 3c0 5.5 2.2 7.2 5 9-2.8 1.8-5 3.5-5 9M17 3c0 5.5-2.2 7.2-5 9 2.8 1.8 5 3.5 5 9M9 7h6m-6 12h6"/>',
  split: '<path d="M5 20v-2a6 6 0 0 1 6-6h2a5 5 0 0 0 5-5V4m-4 4 4-4 4 4M6 5v2c0 2.4 1.5 4.4 4 5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  card: '<rect x="2.8" y="4.6" width="18.4" height="14.8" rx="2.5"/><path d="M3 9h18M6.5 15.5h4"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.8 8.5c-.6-.6-1.5-.9-2.6-.9-1.6 0-2.7.8-2.7 2 0 3.1 5.3 1.6 5.3 4.6 0 1.2-1.1 2.1-2.8 2.1-1.2 0-2.2-.4-3.1-1.2M12 6.1v1.4m0 8.9v1.5"/>',
  check: '<path d="m5 12 4.8 4.8L19 7.5"/>',
  refund: '<path d="m9 3-5 5 5 5M4 8h8.5a6.5 6.5 0 1 1 0 13H9"/>',
  fast: '<path d="m3 5 8 7-8 7zm10 0 8 7-8 7z"/>',
  lamp: '<path d="M3 13a9 9 0 1 1 18 0zM12 13v6m-4 2 1-2h6l1 2z"/>',
  bag: '<path d="M5 8h14l1 13H4zM8 8V7a4 4 0 1 1 8 0v1"/>',
  audio: '<path d="M4 15v-3a8 8 0 0 1 16 0v3M4 13h3v7H5a2 2 0 0 1-2-2v-3c0-1 .4-2 1-2zm16 0h-3v7h2a2 2 0 0 0 2-2v-3c0-1-.4-2-1-2z"/>',
  layers: '<path d="m2 8 10-5 10 5-10 5zm1 5 9 4.5 9-4.5M3 17l9 4.5 9-4.5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 5v2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8v.1"/>'
};
export function icon(name, size = 20) {
  return '<svg class="icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || '') + '</svg>';
}
