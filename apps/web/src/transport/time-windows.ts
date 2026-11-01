// 按 IANA 当地日历日构造边界，夏令时切换日不会被固定 UTC 24h 代替。
export function localDayBoundary(date:string,timezone:string,offsetDays=0):string {
  const calendar=new Date(date+'T00:00:00Z');calendar.setUTCDate(calendar.getUTCDate()+offsetDays);
  const target=calendar.getTime(),formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  let instant=target;
  for(let i=0;i<5;i++){const parts=Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part=>[part.type,part.value]));const represented=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));const adjustment=target-represented;if(adjustment===0)return new Date(instant).toISOString();instant+=adjustment;}
  throw new Error('当前时区的日历边界无法确定');
}
export function periodWindows(date:string,timezone:string,days:number){return {target:{start:localDayBoundary(date,timezone,1-days),end:localDayBoundary(date,timezone,1)},baseline:{start:localDayBoundary(date,timezone,1-2*days),end:localDayBoundary(date,timezone,1-days)}};}
