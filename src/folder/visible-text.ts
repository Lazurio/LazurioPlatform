/** A character that is not shown as itself: a C0 or C1 control (ESC starts a
 * terminal escape), DEL, or an invisible or bidirectional format character
 * that makes a name read differently than it is. Shared by the refresh's
 * named paths (`src/update/folder-refresh.ts`) and the report of a Folder's
 * foreign top-level entries (`foreign-entries.ts`). */
export const invisibleCodePoint = (point: number) =>
  point < 0x20 ||
  (point >= 0x7f && point <= 0x9f) ||
  point === 0xad ||
  point === 0x61c ||
  point === 0x180e ||
  (point >= 0x200b && point <= 0x200f) ||
  (point >= 0x2028 && point <= 0x202e) ||
  (point >= 0x2060 && point <= 0x206f) ||
  point === 0xfeff;

/** Whether every character of `text` is shown as itself. */
export const shownAsItself = (text: string) =>
  ![...text].some((character) =>
    invisibleCodePoint(character.codePointAt(0) ?? 0),
  );
