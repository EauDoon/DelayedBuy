"""Offline SGD scenario model. Rates are decimal fractions and simple ACT/365 APR."""
import argparse
import csv
from dataclasses import asdict, dataclass, replace
from decimal import Decimal, ROUND_FLOOR, ROUND_HALF_UP
from pathlib import Path

D = Decimal
ZERO, ONE, CENT = D(0), D(1), D('.01')


def cash_floor(value):
    return value.quantize(CENT, rounding=ROUND_FLOOR)


@dataclass(frozen=True)
class Inputs:
    principal: Decimal = D('100')
    apr: Decimal = D('.04')
    complete_days: Decimal = D(7)
    cancel_days: Decimal = D(7)
    idle_days: Decimal = ZERO
    cancel_rate: Decimal = D('.25')
    cancel_shopper_share: Decimal = D('.80')
    complete_shopper_share: Decimal = ZERO
    impairment: Decimal = ZERO
    card_rate: Decimal = D('.034')
    card_fixed: Decimal = D('.50')
    extra_refund_fee: Decimal = ZERO
    conversion_per_leg: Decimal = D('.0005')
    gas: Decimal = D('.05')
    ops: Decimal = D('.10')
    dispute_completed: Decimal = D('.002')
    dispute_canceled: Decimal = ZERO
    control_dispute_completed: Decimal = D('.002')
    principal_lgd: Decimal = D('.50')
    dispute_fee: Decimal = D(15)
    counter_fraction: Decimal = ZERO
    counter_loss_rate: Decimal = D('.50')
    counter_fee: Decimal = D(15)

    def __post_init__(self):
        values = asdict(self)
        if any(not isinstance(v, D) or not v.is_finite() for v in values.values()):
            raise ValueError('Use finite Decimal values.')
        if self.principal <= 0 or cash_floor(self.principal) != self.principal:
            raise ValueError('Principal must be positive and denominated in whole cents.')
        if any(v < 0 for k, v in values.items() if k != 'apr'):
            raise ValueError('Only APR can be negative.')
        fractions = ('cancel_rate', 'cancel_shopper_share', 'complete_shopper_share', 'impairment',
                     'card_rate', 'conversion_per_leg', 'dispute_completed', 'dispute_canceled',
                     'control_dispute_completed', 'principal_lgd', 'counter_fraction', 'counter_loss_rate')
        if any(values[k] > 1 for k in fractions):
            raise ValueError('A rate or share exceeds 100%.')
        if 1 + self.apr * max(ZERO, max(self.complete_days, self.cancel_days) - self.idle_days) / 365 < 0:
            raise ValueError('Simple APR over the modeled period implies a negative redemption value.')


def settle(p, days, shopper_share):
    """Settle on full redemption, carry sub-cent dust, and reconcile the realized cents."""
    deployed_days = max(ZERO, days - p.idle_days)
    interest = p.principal * p.apr * deployed_days / 365
    redeemed = (p.principal + interest) * (ONE - p.impairment)
    available = cash_floor(redeemed)
    profit = max(ZERO, available - p.principal)
    # For two beneficiaries, nearest cent to shopper is largest remainder; ties to shopper.
    shopper = (profit * shopper_share).quantize(CENT, rounding=ROUND_HALF_UP)
    return dict(deployed_days=deployed_days, interest=interest, redeemed=redeemed,
                dust=redeemed - available, available=available, shopper=shopper,
                merchant=profit - shopper, make_whole=max(ZERO, p.principal - available))


def economics(p):
    c = p.cancel_rate
    settled = settle(p, p.complete_days, p.complete_shopper_share)
    canceled = settle(p, p.cancel_days, p.cancel_shopper_share)

    def mix(key):
        return (ONE - c) * settled[key] + c * canceled[key]

    # The individual processor fee settles in cents before weighting across intents.
    card = (p.principal * p.card_rate + p.card_fixed).quantize(CENT, rounding=ROUND_HALF_UP)
    refund = c * p.extra_refund_fee
    severity = p.principal * p.principal_lgd + p.dispute_fee + p.counter_fraction * p.counter_loss_rate * p.counter_fee
    disputes = ((ONE - c) * p.dispute_completed + c * p.dispute_canceled) * severity
    control_disputes = (ONE - c) * p.control_dispute_completed * severity
    # Stylized conversion fee per leg, on the original notional; SGD quotes assumed symmetric.
    conversion = 2 * p.principal * p.conversion_per_leg
    costs = card + refund + conversion + p.gas + p.ops + disputes
    baseline = (ONE - c) * card + control_disputes
    retained = mix('merchant') - mix('make_whole')
    return dict(principal=p.principal, apr=p.apr, complete_days=p.complete_days, cancel_days=p.cancel_days,
                cancel_rate=c, complete_shopper_share=p.complete_shopper_share,
                cancel_shopper_share=p.cancel_shopper_share, gross_interest=mix('interest'),
                avg_dust=mix('dust'), avg_shopper_bonus=mix('shopper'), avg_merchant_yield=mix('merchant'),
                complete_shopper=settled['shopper'], complete_merchant=settled['merchant'],
                cancel_shopper=canceled['shopper'], cancel_merchant=canceled['merchant'],
                avg_make_whole=mix('make_whole'), card=card, refund=refund, conversion=conversion,
                gas=p.gas, ops=p.ops, disputes=disputes, total_cost=costs,
                control_cost=baseline, incremental_cost=costs - baseline,
                all_in_result=retained - costs, incremental_result=retained - (costs - baseline))


def break_even_apr(p, basis):
    """Continuous threshold before settlement rounding; fixed days and costs, par exits."""
    if p.impairment != 0:
        raise ValueError('Threshold assumes redemption at par.')
    r = economics(p)
    c = p.cancel_rate
    days_retained = ((ONE - c) * max(ZERO, p.complete_days - p.idle_days) * (ONE - p.complete_shopper_share)
                     + c * max(ZERO, p.cancel_days - p.idle_days) * (ONE - p.cancel_shopper_share))
    cost = {'incremental': r['incremental_cost'], 'all_in': r['total_cost']}[basis]
    if cost <= 0:
        return ZERO
    if days_retained == 0:
        return None
    return cost * 365 / (p.principal * days_retained)


def reward_alternatives(p):
    """Pay at decision with merchant-funded SGD credits and no investment or precharge."""
    m = D(25)  # marginal contribution per additional completed order, after ordinary processing
    complete = ONE - p.cancel_rate
    rows = []
    for name, on_complete, on_cancel in [('record only', ZERO, ZERO), ('completion credit', ONE, ZERO),
                                         ('cancellation credit', ZERO, ONE), ('same credit either outcome', ONE, ONE)]:
        spend = complete * on_complete + p.cancel_rate * on_cancel
        # Compare a control at completion=complete with treatment at complete+lift.
        lift = spend / (m - on_complete + on_cancel)
        rows.append(dict(policy=name, credit_on_complete=on_complete, credit_on_cancel=on_cancel,
                         base_completion=complete, unit_contribution=m, spend_at_unchanged_mix=spend,
                         breakeven_absolute_lift=lift, breakeven_completion=complete + lift))
    return rows


def cases():
    p = Inputs()
    yield 'base cohort', p
    for name, changes in [
        ('completed only', dict(cancel_rate=ZERO)), ('canceled only', dict(cancel_rate=ONE)),
        ('80/20 on both outcomes', dict(complete_shopper_share=D('.8'))),
        ('early cancels', dict(cancel_days=D(1))), ('2 idle days', dict(idle_days=D(2))),
        ('existing funded stablecoin wallets', dict(card_rate=ZERO, card_fixed=ZERO, conversion_per_leg=ZERO,
                                                  dispute_completed=ZERO, control_dispute_completed=ZERO)),
        ('zero yield', dict(apr=ZERO)), ('negative 2% APR', dict(apr=D('-.02'))),
        ('2% terminal impairment', dict(impairment=D('.02'))), ('total impairment', dict(impairment=ONE)),
        ('refund fixed cost', dict(extra_refund_fee=D('.50'))),
        ('extra dispute after cancellation', dict(dispute_canceled=D('.005'), principal_lgd=ONE)),
        ('adverse joint case', dict(principal=D(50), cancel_rate=D('.50'), complete_days=D(7),
                                  cancel_days=D(1), idle_days=D(2), apr=ZERO, impairment=D('.02'),
                                  conversion_per_leg=D('.005'), gas=D('.50'), ops=D(1),
                                  dispute_completed=D('.01'), dispute_canceled=D('.005'), principal_lgd=ONE,
                                  extra_refund_fee=D('.50'), counter_fraction=ONE, counter_loss_rate=D('.75'))),
    ]:
        yield name, replace(p, **changes)


def write_csv(path, rows):
    rows = iter(rows)
    first = next(rows)
    with path.open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=first.keys())
        writer.writeheader()
        writer.writerow(first)
        writer.writerows(rows)


def generate(directory):
    directory.mkdir(parents=True, exist_ok=True)
    write_csv(directory / 'inputs.csv', (dict(scenario=name, **asdict(p)) for name, p in cases()))
    write_csv(directory / 'scenarios.csv', (dict(scenario=name, **economics(p)) for name, p in cases()))
    rows = []
    for principal in ('25', '100', '250', '1000'):
        for days in ('1', '7', '14', '30'):
            for apr in ('0', '.02', '.04', '.08'):
                p = Inputs(principal=D(principal), complete_days=D(days), cancel_days=D(days), apr=D(apr))
                r = economics(p)
                rows.append(dict(principal=p.principal, days=days, apr=p.apr, gross_interest=r['gross_interest'],
                                 cancel_shopper=r['cancel_shopper'], cancel_merchant=r['cancel_merchant'],
                                 all_in_result=r['all_in_result'], incremental_result=r['incremental_result'],
                                 break_even_incremental_apr=break_even_apr(p, 'incremental'),
                                 break_even_all_in_apr=break_even_apr(p, 'all_in')))
    write_csv(directory / 'sensitivity.csv', rows)
    write_csv(directory / 'merchant_rewards.csv', reward_alternatives(Inputs()))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent)
    generate(parser.parse_args().output)
