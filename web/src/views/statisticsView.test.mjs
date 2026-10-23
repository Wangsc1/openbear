import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {ref,watch,nextTick} from 'vue';
import {parse,compileScript,compileTemplate,compileStyle} from '@vue/compiler-sfc';

const source=fs.readFileSync(new URL('./StatisticsView.vue',import.meta.url),'utf8');
const descriptor=parse(source).descriptor;
const template=descriptor.template.content;
const script=descriptor.scriptSetup.content;
const css=descriptor.styles.filter(style=>style.scoped).map(style=>style.content).join('\n');

function chartReadoutHarness() {
  const beginning=script.indexOf('// Chart readout interactions:');
  const ending=script.indexOf('// End chart readout interactions.');
  assert.ok(beginning>0 && ending>beginning);
  const hover=script.slice(script.indexOf('function hoverIndex('),script.indexOf('function tooltipStyle('));
  const chart={width:100,left:0,chartWidth:100};
  const state={
    selectedReadout:ref({chart:'',metric:'',index:-1}),timelineRows:ref([{}, {}, {}, {}]),
    trendHoverIndex:ref(-1),qualityHoverIndex:ref(-1),thinkingHoverIndex:ref(-1),modelHover:ref({metric:'',index:-1}),heatHover:ref(null),
    trendChart:ref(chart),qualityChart:ref(chart),thinkingChart:ref(chart),modelCharts:ref({requests:chart}),
    data:ref(null),trendMetric:ref('tokens'),hiddenTrendSeries:ref([]),selectedModels:ref([]),selectedMetrics:ref(['requests']),watch,
  };
  const realWatch=script.match(/^watch\(\[data, trendMetric, hiddenTrendSeries, selectedModels, selectedMetrics\], clearChartReadout\);$/m)?.[0];
  assert.ok(realWatch);
  const functions=vm.runInNewContext(`let readoutPress=null;\n${hover}\n${script.slice(beginning,ending)}\nconst stopDataWatch = ${realWatch}\n({activeChartIndex,clearChartReadout,startChartReadout,stopChartReadout,cancelChartReadout,chartReadoutKeydown,dismissChartReadout,stopDataWatch})`,state);
  const svg={getBoundingClientRect:()=>({left:0,width:100})};
  svg.contains=target=>target===svg;
  const scroll={scrollTop:0};
  const currentTarget={querySelector:()=>svg,closest:()=>scroll};
  const event=(x=70,extras={})=>({currentTarget,target:svg,clientX:x,clientY:30,pointerId:1,pointerType:'touch',button:0,...extras});
  return {state,functions,event,scroll};
}

test('all four real chart handlers pin touch-up values, retain hover previews, and ignore scroll gestures',()=>{
  const {state,functions:h,event,scroll}=chartReadoutHarness();
  for(const [chart,metric] of [['trend',''],['quality',''],['model','requests'],['thinking','']]) {
    h.startChartReadout(event(),chart,metric);
    h.stopChartReadout(event(),chart,metric);
    assert.equal(h.activeChartIndex(chart,metric,-1),2,`${chart} selected bucket survives pointer leave`);
    assert.equal(state.selectedReadout.value.chart,chart);
    assert.equal(h.activeChartIndex(chart,metric,3),3,'mouse hover still previews another bucket');
    assert.equal(h.activeChartIndex(chart,metric,-1),2,'pointer leave restores pinned bucket');
  }
  h.startChartReadout(event(),'trend');
  h.stopChartReadout(event(98),'trend');
  assert.equal(h.activeChartIndex('thinking','',-1),2,'moving finger is not a tap or a new selection');
  h.startChartReadout(event(),'quality');
  scroll.scrollTop=8;
  h.stopChartReadout(event(),'quality');
  assert.equal(h.activeChartIndex('thinking','',-1),2,'vertical scroll cannot select a bucket');
  scroll.scrollTop=0;
  h.startChartReadout(event(),'trend');
  h.cancelChartReadout('trend');
  h.stopChartReadout(event(),'trend');
  assert.equal(h.activeChartIndex('thinking','',-1),2,'native pointercancel leaves previous selection intact');
  h.dismissChartReadout({target:{closest:()=>({})}});
  assert.equal(h.activeChartIndex('thinking','',-1),2,'synthetic click inside the SVG keeps the tap readout');
  h.dismissChartReadout({target:{closest:()=>null}});
  assert.equal(h.activeChartIndex('thinking','',-1),-1,'clicking outside the SVG clears pinned readout');
  h.stopDataWatch();
});

test('keyboard select/navigation and dataset lifecycle clear readouts without breaking touch hit geometry',async()=>{
  const {state,functions:h,event}=chartReadoutHarness();
  const key=(value)=>({key:value,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}});
  const right=key('ArrowRight');h.chartReadoutKeydown(right,'model','requests');
  assert.equal(right.prevented,true);
  assert.equal(h.activeChartIndex('model','requests',-1),0);
  h.chartReadoutKeydown(key('ArrowRight'),'model','requests');
  assert.equal(h.activeChartIndex('model','requests',-1),1);
  h.chartReadoutKeydown(key('ArrowLeft'),'model','requests');
  assert.equal(h.activeChartIndex('model','requests',-1),0);
  const escape=key('Escape');h.chartReadoutKeydown(escape,'model','requests');
  assert.equal(escape.stopped,true,'dismissing the readout does not close an outer navigation layer');
  assert.equal(h.activeChartIndex('model','requests',-1),-1);
  h.startChartReadout(event(50,{target:{}}),'trend');
  h.stopChartReadout(event(),'trend');
  assert.equal(h.activeChartIndex('trend','',-1),-1,'non-SVG surface is not an accidental touch target');
  h.startChartReadout(event(),'trend');h.stopChartReadout(event(),'trend');
  state.trendMetric.value='cost';
  await nextTick();
  assert.equal(h.activeChartIndex('trend','',-1),-1,'changing a data condition dismisses the pinned readout');
  h.startChartReadout(event(),'trend');h.stopChartReadout(event(),'trend');
  state.data.value={timeline:[{bucket:'new'}]};
  await nextTick();
  assert.equal(h.activeChartIndex('trend','',-1),-1,'loading fresh data dismisses the prior readout');
  h.startChartReadout(event(),'trend');h.stopChartReadout(event(),'trend');
  state.timelineRows.value=[];
  assert.equal(h.activeChartIndex('trend','',-1),-1,'stale index cannot expose changed dataset');
  h.stopDataWatch();
  assert.match(script,/watch\(\[data, trendMetric, hiddenTrendSeries, selectedModels, selectedMetrics\], clearChartReadout\)/);
  assert.match(script,/onBeforeUnmount\(\(\) => \{ document\.removeEventListener\("click", dismissChartReadout, true\); \}\)/);
});

test('compiled charts wire tap, cancel, keyboard and ARIA; phone heatmap has precise 7×24 native selectors',()=>{
  const id='statistics-touch';
  const compiled=compileTemplate({source:template,filename:'StatisticsView.vue',id});
  const js=compileScript(descriptor,{id});
  const style=compileStyle({source:css,filename:'StatisticsView.vue',id,scoped:true});
  assert.equal(compiled.errors.length,0);assert.equal(js.errors?.length||0,0);assert.equal(style.errors.length,0);
  for(const chart of ['trend','quality','thinking']) {
    assert.match(template,new RegExp(`@pointerdown="startChartReadout\\(\\$event,'${chart}'\\)"[\\s\\S]*?@pointerup="stopChartReadout\\(\\$event,'${chart}'\\)"`));
    assert.match(template,new RegExp(`@pointercancel="cancelChartReadout\\('${chart}'\\)"`));
    assert.match(template,new RegExp(`@keydown="chartReadoutKeydown\\(\\$event,'${chart}'\\)"`));
  }
  assert.match(template,/@pointerdown="startChartReadout\(\$event,'model',metric\)"/);
  assert.match(template,/@keydown="chartReadoutKeydown\(\$event,'model',metric\)"/);
  assert.match(template,/class="heat-readout-controls"[\s\S]*v-model\.number="heatSelectionDay"[\s\S]*v-model\.number="heatSelectionHour"[\s\S]*data\?\.heatmap\?\.\[heatSelectionDay\]\?\.\[heatSelectionHour\]/);
  assert.match(template,/v-for="hour in 24"/);
  assert.match(css,/\.heat-scroll\{overflow-x:auto;overflow-y:hidden/);
  assert.match(css,/\.heat-readout-controls select\{[^}]*min-height:44px/);
  assert.doesNotMatch(css,/touch-action:\s*none/);
});
