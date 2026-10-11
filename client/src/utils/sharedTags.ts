import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

/** The shared tag list (snippets and devices), with colours */
export interface SharedTag {
  id: number;
  name: string;
  color: string | null;
  deviceCount?: number;
  snippetCount?: number;
}

export const useSharedTags = (): { tags: SharedTag[]; reload: () => Promise<void> } => {
  const [tags, setTags] = useState<SharedTag[]>([]);
  const reload = useCallback(async () => {
    try {
      const res = await axios.get<{ data: SharedTag[] }>('/api/tags');
      setTags(res.data.data || []);
    } catch {
      setTags([]);
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { tags, reload };
};

/** Readable text on a tag colour */
export const tagTextColor = (color: string | null): string => {
  if (!color) return 'inherit';
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#111' : '#fff';
};
