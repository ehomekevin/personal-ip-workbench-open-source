import type { ArticleBlock } from '../../../contracts/src/article-layout.ts';
// 公众号排版：小节标题识别。Markdown「## 」之外，中文稿常用「三、…」「第二部分：…」作小节。
const SECTION_NUMBER=/^(?:[一二三四五六七八九十百]{1,3}[、．.]|[（(][一二三四五六七八九十百]{1,3}[)）]|第[一二三四五六七八九十百\d]{1,3}[部分章节步点个条]{1,2}[、：:．.\s]?)/;
/** 中文序号小节标题：短（≤40 字）、一行、不以句末标点结尾。整行加粗（**…**）也算。 */
export function sectionHeading(line:string):{text:string;prefix:string;suffix:string}|null{
 const bold=line.match(/^(\*\*|__)(.+)\1$/),text=bold?bold[2]!:line,trimmed=text.trim();
 if(!trimmed||trimmed!==text||Array.from(trimmed).length>40||!SECTION_NUMBER.test(trimmed)||/[。；，,;：:]$/.test(trimmed))return null;
 const rest=trimmed.replace(SECTION_NUMBER,'').trim();if(!rest)return null;
 return{text,prefix:bold?bold[1]!:'',suffix:bold?bold[1]!:''};
}
/** 小节标题自带序号（「三、…」）时，预览不再加 01/02 编号。 */
export const headingHasNumber=(text:string)=>SECTION_NUMBER.test(text.trim());
/** 显示用的块类型：C2 之前导入的记录里，中文序号小节被存成了正文段落；这里按同一规则当小节标题显示和检查，不改记录。 */
export function layoutBlockKind(block:ArticleBlock):ArticleBlock['kind']{if(block.kind!=='paragraph'||block.source_prefix!==''||/[\r\n]/.test(block.text))return block.kind;return sectionHeading(block.text)?.prefix===''?'heading':block.kind;}
