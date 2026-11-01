// 批准原型的 DOM 边界集中于此；选择器局限在一个 React Workbench 根节点内。
export type ControlElement = HTMLElement & Pick<HTMLInputElement,'value'|'checked'|'disabled'|'name'|'files'> & Pick<HTMLDialogElement,'open'|'showModal'|'close'>;
export type DomEvent = Event & {target:ControlElement; currentTarget:ControlElement; key:string; metaKey:boolean; ctrlKey:boolean; clientX:number; clientY:number};
export function scopedDom(root: HTMLElement, signal: AbortSignal) {
  return {
    getElementById(id:string): ControlElement { const el=root.querySelector<ControlElement>('#'+id); if(!el)throw new Error('Missing approved control: '+id); return el; },
    querySelector(selector:string){ return root.querySelector<ControlElement>(selector); },
    querySelectorAll(selector:string){ return root.querySelectorAll<ControlElement>(selector); },
    createElement: root.ownerDocument.createElement.bind(root.ownerDocument),
    get visibilityState(){return root.ownerDocument.visibilityState;},
    addEventListener(type:string, listener:(event:DomEvent)=>void){ (type==='keydown'?root.ownerDocument:root).addEventListener(type,event=>listener(event as DomEvent),{signal}); }
  };
}
