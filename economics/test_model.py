"""Run python3 -m unittest discover -s economics -p 'test_*.py' from the bundle root."""
import csv
import tempfile
import unittest
from pathlib import Path

from model import CENT, D, Inputs, ONE, ZERO, break_even_apr, cash_floor, economics, generate, replace, reward_alternatives, settle


class EconomicModelTests(unittest.TestCase):
    def test_fixture_by_independent_hand_calculation(self):
        r = economics(Inputs())
        for key, expected in dict(gross_interest=D(28) / 365, cancel_shopper='.06',
                                  cancel_merchant='.01', complete_merchant='.07', avg_merchant_yield='.055',
                                  avg_shopper_bonus='.015', disputes='.0975', total_cost='4.2475',
                                  control_cost='3.0225', incremental_cost='1.225', incremental_result='-1.17').items():
            self.assertEqual(r[key], D(expected), key)
        self.assertLess(r['avg_dust'], CENT)

    def test_conservation_every_branch_including_cents_and_ties(self):
        for amount in ('.01', '1.31', '25.50', '100', '999.99'):
            for share in ('0', '.2', '.5', '.8', '1'):
                for days in ('0', '.5', '7', '365'):
                    for apr in ('-.1', '0', '.04', '1'):
                        for loss in ('0', '.02', '1'):
                            p = Inputs(principal=D(amount), apr=D(apr), impairment=D(loss))
                            a = settle(p, D(days), D(share))
                            self.assertEqual(a['available'] + a['make_whole'],
                                             p.principal + a['shopper'] + a['merchant'])
                            self.assertEqual(a['redeemed'] - a['available'], a['dust'])
                            self.assertTrue(ZERO <= a['dust'] < CENT)
                            for k in ('available', 'make_whole', 'shopper', 'merchant'):
                                self.assertEqual(cash_floor(a[k]), a[k])
                                self.assertGreaterEqual(a[k], ZERO)
                            self.assertFalse(a['make_whole'] and (a['shopper'] or a['merchant']))
        a = settle(Inputs(principal=ONE, apr=D('.01')), D(365), D('.5'))
        self.assertEqual((a['shopper'], a['merchant']), (CENT, ZERO))

    def test_incremental_removes_only_ordinary_completion_costs(self):
        complete = economics(Inputs(cancel_rate=ZERO))
        cancel = economics(Inputs(cancel_rate=ONE))
        self.assertEqual(complete['incremental_cost'], D('.25'))
        self.assertEqual(cancel['incremental_cost'], D('4.15'))
        self.assertEqual(cancel['control_cost'], ZERO)
        self.assertEqual(economics(Inputs(extra_refund_fee=D('.50')))['incremental_cost'], D('1.35'))

    def test_processor_fee_settles_before_cohort_weighting(self):
        r = economics(Inputs(principal=D('100.15')))
        self.assertEqual(r['card'], D('3.91'))
        self.assertEqual(r['control_cost'], D('.75') * (D('3.91') + D('.002') * (D('50.075') + 15)))

    def test_no_duplicate_principal_and_dispute_sensitivity(self):
        p = Inputs(dispute_completed=D('.01'), dispute_canceled=D('.005'), principal_lgd=D('.75'),
                   counter_fraction=D('.5'), counter_loss_rate=D('.25'))
        r = economics(p)
        severity = D(75 + 15) + D('.5') * D('.25') * 15
        self.assertEqual(r['disputes'], (D('.75') * D('.01') + D('.25') * D('.005')) * severity)
        self.assertEqual(r['control_cost'], D('.75') * (D('3.90') + D('.002') * severity))
        self.assertEqual(r['avg_make_whole'], ZERO)

    def test_no_deployed_days_and_full_impairment(self):
        self.assertEqual(economics(Inputs(idle_days=D(8)))['gross_interest'], ZERO)
        a = economics(Inputs(impairment=ONE))
        self.assertEqual(a['avg_make_whole'], D(100))
        self.assertEqual(a['avg_shopper_bonus'] + a['avg_merchant_yield'], ZERO)
        self.assertEqual(a['incremental_result'], -D('101.225'))

    def test_thresholds_include_costs_and_retainable_fraction(self):
        p = Inputs()
        rate = break_even_apr(p, 'incremental')
        self.assertEqual(rate, D('.7984375'))
        self.assertEqual(p.principal * rate * D(7) / 365 * D('.8'), D('1.225'))
        self.assertIsNone(break_even_apr(replace(p, idle_days=D(9)), 'incremental'))
        self.assertIsNone(break_even_apr(replace(p, cancel_rate=ONE, cancel_shopper_share=ONE), 'all_in'))
        self.assertRaises(ValueError, break_even_apr, replace(p, impairment=D('.01')), 'all_in')

    def test_whole_cent_thresholds_can_shift_either_direction(self):
        # Choose principal=365 and one day to produce an exact target gain in cents.
        for low_gain, target_gain, cost in [('1.52', '1.53', '1.225'), ('5.30', '5.31', '4.2475')]:
            for gain, enough in [(low_gain, False), (target_gain, True)]:
                p = Inputs(principal=D(365), complete_days=ONE, cancel_days=ONE, apr=D(gain))
                self.assertEqual(economics(p)['avg_merchant_yield'] >= D(cost), enough)

    def test_merchant_credit_lift_charges_incremental_conversions_too(self):
        rows = reward_alternatives(Inputs())
        self.assertEqual(rows[1]['breakeven_absolute_lift'], D('.03125'))
        for r in rows:
            t = r['breakeven_completion']
            uplift = r['unit_contribution'] * (t - r['base_completion'])
            paid = t * r['credit_on_complete'] + (ONE - t) * r['credit_on_cancel']
            self.assertLess(abs(uplift - paid), D('1e-24'))

    def test_rejects_bad_inputs(self):
        for changes in (dict(cancel_rate=D('1.01')), dict(principal=D('1.001')), dict(apr=D('NaN')),
                        dict(principal=ZERO), dict(gas=D('-1')), dict(apr=D('-100'))):
            with self.assertRaises(ValueError):
                Inputs(**changes)

    def test_generated_tables_are_reproducible(self):
        with tempfile.TemporaryDirectory() as folder:
            generate(Path(folder))
            for path in Path(folder).glob('*.csv'):
                self.assertEqual(path.read_bytes(), (Path(__file__).parent / path.name).read_bytes())
            with (Path(folder) / 'sensitivity.csv').open(newline='') as f:
                self.assertEqual(len(list(csv.DictReader(f))), 64)


if __name__ == '__main__':
    unittest.main()
