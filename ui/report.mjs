import { reportRows, fundingComparison, sensitivityCsv } from './report-data.mjs';

const catalog = reportRows();
const windows = [1,7,14,30];
function cash(v,places=2) { const n=Number(v); return (n<0?'−':'')+'S$'+Math.abs(n).toLocaleString('en-SG',{minimumFractionDigits:places,maximumFractionDigits:places}); }
function principal(v) {return cash(v,0);}
function option(values,choice,label) {return values.map(v=>'<option value="'+v+'"'+(v===choice?' selected':'')+'>'+label(v)+'</option>').join('');}
function selectRow(b,d,a) {return catalog.find(r=>r[0]===b && r[1]===d && r[2]===a);}
export function reportSummary(basket,days,apr) {
  const row=selectRow(basket,days,apr);
  if (!row) throw new RangeError('Choose a listed model scenario.');
  return {row, series:windows.map(d=>selectRow(basket,d,apr)), negative:catalog.filter(r=>Number(r[6])<0).length, total:catalog.length};
}
function receipt(k,v,cls) {return '<div class="r-cell '+cls+'"><span>'+k+'</span><b>'+v+'</b></div>';}
function statRows(series,sel) {
  const top=Math.max(...series.map(r=>Number(r[3])));
  return series.map(r=>'<div class="r-bar-row'+(r[1]===sel?' r-active':'')+'"><span>'+r[1]+'d</span><div class="r-track" aria-hidden="true"><i style="width:'+(top ? 100*Number(r[3])/top : 0).toFixed(4)+'%"></i></div><strong>'+cash(r[3],4)+'</strong></div>').join('');
}
export function reportResults(b,d,a) {
  const {row:r,series,negative,total}=reportSummary(b,d,a);
  const label=principal(b)+' · '+d+' invested day'+(d===1?'':'s')+' · '+a+'% simple annual rate';
  return '<div class="r-receipt"><div class="r-ticket-title"><span>Card-funded scenario</span><small>'+label+'</small></div><div class="r-cell-grid">'+
    receipt('Gross interest per hold',cash(r[3],4),'r-gross')+receipt('Shopper’s interest share if canceled',cash(r[4]),'r-share')+receipt('Merchant’s interest share if canceled',cash(r[5]),'r-merchant')+'</div>'+
    '<p class="r-caption">Cancellation splits whole cents 80/20, using the largest remainder and giving ties to the shopper. Sub-cent interest is not paid out. Principal is separate.</p></div>'+
    '<div class="r-analysis"><section class="r-bars"><span class="r-eyebrow">01 / Time</span><h2>What waiting adds</h2><p>Gross interest per hold, at '+principal(b)+' and '+a+'%. All bars start at zero and share one scale for this basket and rate.</p><div class="r-bars-list" aria-label="Gross interest by invested days">'+statRows(series,d)+'</div></section>'+
    '<section class="r-net"><span class="r-eyebrow">02 / Trade-off</span><h2>Cost of charging upfront</h2><strong class="r-big" data-net>'+cash(r[6],4)+'</strong><p>Modeled change in merchant and operator contribution per started intent versus charging only when a shopper buys. Negative means early capture does worse.</p><small>25% cancel. The merchant receives all completion yield. '+negative+' of '+total+' card-funded scenarios are negative under these assumptions. Not an observed outcome.</small></section></div>';
}
function fixedComparison() {
  const [card, wallet] = fundingComparison();
  const lines = [
    ['Merchant interest retained', 'avg_merchant_yield'],
    ['Cost of charging upfront', 'total_cost'],
    ['Ordinary completion cost deducted', 'control_cost'],
    ['Contribution change per start', 'incremental_result']
  ];
  const rows = lines.map(([label, key]) => '<tr><th scope="row">' + label + '</th><td>' +
    cash(card[key], 4) + '</td><td>' + cash(wallet[key], 4) + '</td></tr>').join('');
  return '<section class="r-comparison"><span class="r-eyebrow">Fixed comparison</span>' +
    '<h2>What changes with a funded wallet?</h2><p>Both cases assume a ' + principal(card.principal) +
    ' equivalent basket, ' + card.complete_days + ' invested days, ' + (100 * Number(card.apr)) +
    '% APR and ' + (100 * Number(card.cancel_rate)) + '% cancellations. Each figure is an average per started checkout.</p>' +
    '<table><caption>Modeled amounts in SGD equivalents</caption><thead><tr><th scope="col">Per start</th>' +
    '<th scope="col">Card</th><th scope="col">Funded wallet</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<p>The wallet starts funded. It assumes ' + cash(wallet.gas) + ' in network costs and ' + cash(wallet.ops) +
    ' in operations per start, with zero card, conversion, extra refund or dispute costs. No ordinary completion cost is modeled for this wallet.</p>' +
    '<p>For cards, charging only on completion already costs ' + cash(card.control_cost, 4) +
    ' per start in processing and expected disputes. Subtract that ordinary cost from upfront cost before comparing it with retained interest. These are modeled outcomes.</p></section>';
}
export function reportPage(b=100,d=7,a=4) {
  return '<article class="r-page"><div class="r-cover"><div class="r-cover-inner"><div><span class="r-eyebrow">Illustrated scenario model</span><h1>The price<br>of a <em>pause.</em></h1><p>What could a card payment earn during a hold? Change the basket, time and assumed rate. The separate checkout demo pays no interest.</p><button type="button" class="r-cover-link" data-explore-report>Explore the scenarios <span aria-hidden="true">↓</span></button></div>'+
    '<figure class="r-figure" aria-label="Illustration: a seven-day pause between reserve and decide"><div class="r-poster"><span class="r-poster-top">S$100 · Assumed 4% annual rate</span><svg viewBox="0 0 260 152" aria-hidden="true" focusable="false"><g fill="none" stroke="#663946" stroke-width="2">'+
    '<circle cx="78" cy="76" r="58"/><circle cx="96" cy="76" r="58"/><circle cx="114" cy="76" r="58"/><circle cx="132" cy="76" r="58"/><circle cx="150" cy="76" r="58"/><circle cx="168" cy="76" r="58"/><circle cx="186" cy="76" r="58"/></g><path d="M38 76h178m-7-6 7 6-7 6" fill="none" stroke="#171e1b" stroke-width="3"/></svg><div class="r-endpoints"><span>Reserve</span><b>7 days</b><span>Decide</span></div></div><figcaption>In this seven-day example, '+cash(selectRow(100,7,4)[3],4)+' accrues before the cancellation split.</figcaption></figure></div></div>'+
    '<div class="r-body"><div class="r-controls-head"><div><span class="r-eyebrow">64 card-funded cases</span><h2>Build a scenario.</h2></div><p>All values are illustrative SGD equivalents. Change one assumption to see what moves.</p></div><div class="r-controls">'+
    '<label>Basket<select id="r-basket" data-report="basket">'+option([25,100,250,1000],b,principal)+'</select></label><label>Invested time<select id="r-days" data-report="days">'+option(windows,d,v=>v+' day'+(v===1?'':'s'))+'</select></label><label>Annual rate<select id="r-apr" data-report="apr">'+option([0,2,4,8],a,v=>v+'%')+'</select></label></div>'+
    '<div id="r-results" aria-live="polite" aria-atomic="true">'+reportResults(b,d,a)+'</div>'+
    fixedComparison() +
    '<details class="r-method"><summary>Read the assumptions and limits</summary><p>Gross interest = principal × annual rate × invested days ÷ 365, without compounding. It assumes par redemption and stable exchange rates. It does not establish demand, bank posting times, legal permission, or executable lending rates.</p><p><a download="sensitivity.csv" href="data:text/csv;charset=utf-8,'+encodeURIComponent(sensitivityCsv())+'">Download the 64 card-funded cases (CSV)</a>. APRs in the file are fractions (0.04 means 4%). Break-even APRs are continuous estimates before whole-cent settlement rounding. No money is invested by this demo.</p></details>'+
    '<section class="r-close"><span class="r-eyebrow">03 / Next experiment</span><h2>Try the pause without the prepayment.</h2><p>Compare saving an item for later with ordinary checkout. Measure two outcomes together: fewer regretted purchases and sales customers still want to keep. Neither outcome has been demonstrated here.</p><a href="#checkout">Return to the checkout simulation →</a></section></div></article>';
}
