export interface SelectBoundedHierarchyNodeOptions {
  readonly preferredNodeKey?: string;
  readonly query?: string;
  readonly maxOptionCount: number;
}

export interface HierarchyNodeKey {
  readonly key: string;
}

export function selectBoundedHierarchyNodeOptions<T extends HierarchyNodeKey>(
  nodes: readonly T[],
  options: SelectBoundedHierarchyNodeOptions,
): T[] {
  const maxOptionCount = Math.max(0, Math.floor(options.maxOptionCount));

  if (maxOptionCount === 0 || nodes.length === 0) {
    return [];
  }

  const preferredNodeKey = options.preferredNodeKey?.trim() ?? "";
  const query = options.query?.trim().toLowerCase() ?? "";
  const selectedNodes: T[] = [];
  const selectedNodeKeys = new Set<string>();

  const appendNode = (node: T): void => {
    if (selectedNodes.length >= maxOptionCount || selectedNodeKeys.has(node.key)) {
      return;
    }

    selectedNodes.push(node);
    selectedNodeKeys.add(node.key);
  };

  const preferredNode = preferredNodeKey
    ? nodes.find((node) => node.key === preferredNodeKey)
    : undefined;

  if (preferredNode) {
    appendNode(preferredNode);
  }

  for (const node of nodes) {
    if (query && !node.key.toLowerCase().includes(query)) {
      continue;
    }

    appendNode(node);
  }

  return selectedNodes;
}

export function resolveLoadedHierarchyNodeKey(
  loadedNodeKeys: ReadonlySet<string>,
  typedNodeKey: string,
  selectedNodeKey: string,
): string {
  const typedKey = typedNodeKey.trim();

  if (typedKey && loadedNodeKeys.has(typedKey)) {
    return typedKey;
  }

  const selectedKey = selectedNodeKey.trim();
  return loadedNodeKeys.has(selectedKey) ? selectedKey : "";
}
