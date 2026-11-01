import { useEffect, useRef } from 'react';
// 文字块编辑节点（排版叶子与 C1 排版页共用）：输入、保存、选区与输入法组合期间节点保持挂载，只接受纯文字。
function insertPlainText(el: HTMLElement, value: string) {
  const selection = window.getSelection(); if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0); if (!el.contains(range.commonAncestorContainer)) return;
  range.deleteContents(); const node = document.createTextNode(value); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
}
/** The contenteditable node stays mounted during input, saves, selection and composition. */
export function EditableText({ id, value, label, className = '', editable, onSelect, onEdit, onSave }: { id: string; value: string; label: string; className?: string; editable: boolean; onSelect: () => void; onEdit: (value: string) => void; onSave: () => void }) {
  const ref = useRef<HTMLDivElement>(null), composing = useRef(false);
  useEffect(() => { const el = ref.current; if (el && !composing.current && document.activeElement !== el && el.innerText !== value) el.textContent = value; }, [value]);
  const read = () => { if (ref.current) onEdit(ref.current.innerText.replace(/\r\n/g, '\n')); };
  return <div ref={ref} data-text-block={id} className={'al-editable ' + className} role={editable ? 'textbox' : undefined} aria-label={editable ? label : undefined} aria-multiline={editable ? 'true' : undefined}
    contentEditable={editable ? 'plaintext-only' : false} suppressContentEditableWarning spellCheck={false}
    onFocus={onSelect} onInput={read} onBlur={() => { if (!composing.current) { if (ref.current && ref.current.innerText !== value) ref.current.textContent = value; onSave(); } }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; read(); }}
    onBeforeInput={event => { const native = event.nativeEvent as InputEvent; if (!composing.current && (native.inputType === 'insertParagraph' || native.inputType === 'insertLineBreak')) { event.preventDefault(); if (ref.current) { insertPlainText(ref.current, '\n'); read(); } } }}
    onPaste={event => { if (!editable || composing.current) return; event.preventDefault(); if (ref.current) { insertPlainText(ref.current, event.clipboardData.getData('text/plain').replace(/\r\n/g, '\n')); read(); } }} />;
}

