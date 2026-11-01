import {ICONS,P} from './metadata.ts';
import type {SourceView} from '../app/view-model.ts';
export function createTemplateHelpers(NEWS: SourceView[]){
function esc(s: unknown){return String(s==null?'':s).replace(/[&<>"']/g,c=>(({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as Record<string,string>)[c]))}
function icon(name: string){return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="'+((ICONS as Record<string,string>)[name]||ICONS.file)+'"/></svg>'}
function btn(label: string,action: string,primary=false,attrs=''){return '<button class="button'+(primary?' primary':'')+'" data-action="'+action+'" '+attrs+'>'+esc(label)+'</button>'}
function small(label: string,action: string,attrs=''){return '<button class="button small" data-action="'+action+'" '+attrs+'>'+esc(label)+'</button>'}
function iconBtn(name: string,action: string,label: string,attrs=''){return '<button class="icon-button" data-action="'+action+'" aria-label="'+esc(label)+'" title="'+esc(label)+'" '+attrs+'>'+icon(name)+'</button>'}
function tag(text: unknown,cls=''){return '<span class="tag '+cls+'">'+esc(text)+'</span>'}
function platformBadge(p: string){return '<span class="mini-platform" title="'+P[p].name+'">'+P[p].short+'</span>'}
function heading(english: string,title: string,sub: string,actions=''){return '<div class="page-heading"><div><div class="eyebrow">'+english+'</div><h1>'+title+'</h1><p class="subtitle">'+sub+'</p></div><div class="button-row">'+actions+'</div></div>'}
function section(title: string,action=''){return '<div class="section-head"><h2>'+title+'</h2>'+action+'</div>'}
function tabs(items: string[][],active: string,action: string){return '<div class="tabs">'+items.map(i=>'<button class="tab '+(i[0]===active?'active':'')+'" data-action="'+action+'" data-value="'+i[0]+'">'+i[1]+'</button>').join('')+'</div>'}
function sourceTag(id: string){const n=NEWS.find(n=>n.id===id);return '<button class="evidence-link" data-action="read-news" data-id="'+id+'">'+esc(n?n.title:'示例资料')+'</button>'}
return {esc,icon,btn,small,iconBtn,tag,platformBadge,heading,section,tabs,sourceTag};
}
