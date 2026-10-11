export type TagreelPickerBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TagreelPickerElementInfo = {
  id: string | null;
  tagName: string;
  selector: string;
  label: string;
  boundingBox: TagreelPickerBoundingBox;
  textContent: string | null;
  src: string | null;
  dataAttributes: Record<string, string>;
};

export type TagreelPickerApi = {
  enable: () => void;
  disable: () => void;
  isActive: () => boolean;
  getHovered: () => TagreelPickerElementInfo | null;
  getSelected: () => TagreelPickerElementInfo | null;
  getCandidatesAtPoint: (
    clientX: number,
    clientY: number,
    limit?: number,
  ) => TagreelPickerElementInfo[];
  pickAtPoint: (
    clientX: number,
    clientY: number,
    index?: number,
  ) => TagreelPickerElementInfo | null;
  pickManyAtPoint: (
    clientX: number,
    clientY: number,
    indexes?: number[],
  ) => TagreelPickerElementInfo[];
  describe?: (element: Element) => TagreelPickerElementInfo | null;
};

declare global {
  interface Window {
    __HF_PICKER_API?: TagreelPickerApi;
  }
}
