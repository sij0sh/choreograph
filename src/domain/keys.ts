export function lastSegment(key: string): string {
  const index = key.lastIndexOf("/");
  return index < 0 ? key : key.slice(index + 1);
}

export function planKeyOf(nodeKey: string): string {
  return nodeKey.slice(0, nodeKey.lastIndexOf("/"));
}
