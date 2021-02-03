/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const { assert } = require('chai');
const { StatsD } = require('hot-shots');
const sinon = require('sinon');
const { Container } = require('typedi');

const {
  PayPalClient,
  PayPalClientError,
} = require('../../../lib/payments/paypal-client');
const { PayPalHelper } = require('../../../lib/payments/paypal');
const { mockLog } = require('../../mocks');
const error = require('../../../lib/error');
const successfulSetExpressCheckoutResponse = require('./fixtures/paypal/set_express_checkout_success.json');
const successfulDoReferenceTransactionResponse = require('./fixtures/paypal/do_reference_transaction_success.json');
const eventCustomerSourceExpiring = require('./fixtures/stripe/event_customer_source_expiring.json');
const sampleIpnMessage = require('./fixtures/paypal/sample_ipn_message.json');
const { StripeHelper } = require('../../../lib/payments/stripe');

describe('PayPalHelper', () => {
  /** @type PayPalHelper */
  let paypalHelper;
  let mockStripeHelper;

  const chargeId = 'ch_1GVm24BVqmGyQTMaUhRAfUmA';
  const sourceId = eventCustomerSourceExpiring.data.object.id;
  const mockInvoice = {
    id: 'inv_0000000000',
    number: '1234567',
    charge: chargeId,
    default_source: { id: sourceId },
    total: 1234,
    currency: 'usd',
    period_end: 1587426018,
    lines: {
      data: [
        {
          period: { end: 1590018018 },
        },
      ],
    },
  };

  const mockCustomer = {
    invoice_settings: {
      default_payment_method: {},
    },
  };

  beforeEach(() => {
    mockStripeHelper = {};
    Container.set(StripeHelper, mockStripeHelper);

    // Make PayPalClient
    const paypalClient = new PayPalClient({
      user: 'user',
      sandbox: true,
      pwd: 'pwd',
      signature: 'sig',
    });
    Container.set(PayPalClient, paypalClient);
    // Make StatsD
    const statsd = { increment: sinon.spy() };
    Container.set(StatsD, statsd);
    // Make PayPalHelper
    paypalHelper = new PayPalHelper({ mockLog });
  });

  describe('constructor', () => {
    it('sets client, statsd, and logger', () => {
      const paypalClient = new PayPalClient({
        user: 'user',
        sandbox: true,
        pwd: 'pwd',
        signature: 'sig',
      });
      const statsd = { increment: sinon.spy() };
      Container.set(PayPalClient, paypalClient);
      Container.set(StatsD, statsd);

      const pph = new PayPalHelper({ log: mockLog });
      assert.equal(pph.client, paypalClient);
      assert.equal(pph.log, mockLog);
      assert.equal(pph.metrics, statsd);
    });
  });

  describe('getCheckoutToken', () => {
    it('it returns the token from doRequest', async () => {
      paypalHelper.client.doRequest = sinon.fake.resolves(
        successfulSetExpressCheckoutResponse
      );
      const token = await paypalHelper.getCheckoutToken();
      assert.equal(token, successfulSetExpressCheckoutResponse.TOKEN);
    });

    it('if doRequest unsuccessful, throws an error', async () => {
      paypalHelper.client.doRequest = sinon.fake.throws(
        new PayPalClientError('Fake', {})
      );
      try {
        await paypalHelper.getCheckoutToken();
        assert.fail('Request should have thrown an error.');
      } catch (err) {
        assert.instanceOf(err, PayPalClientError);
        assert.equal(err.name, 'PayPalClientError');
      }
    });
  });

  describe('createBillingAgreement', () => {
    const validOptions = {
      token: 'insert_token_value_here',
    };

    const expectedResponse = {
      BILLINGAGREEMENTID: 'B-7FB31251F28061234',
      ACK: 'Success',
    };

    it('calls createBillingAgreement with passed options', async () => {
      paypalHelper.client.createBillingAgreement = sinon.fake.resolves(
        expectedResponse
      );
      const response = await paypalHelper.createBillingAgreement(validOptions);
      sinon.assert.calledOnceWithExactly(
        paypalHelper.client.createBillingAgreement,
        validOptions
      );
      assert.equal(response, 'B-7FB31251F28061234');
    });
  });

  describe('chargeCustomer', () => {
    const validOptions = {
      amount: '10.99',
      billingAgreementId: 'B-12345',
      invoiceNumber: 'in_asdf',
      idempotencyKey: ' id1234',
    };

    it('calls doReferenceTransaction with passed options', async () => {
      paypalHelper.client.doReferenceTransaction = sinon.fake.resolves(
        successfulDoReferenceTransactionResponse
      );
      await paypalHelper.chargeCustomer(validOptions);
      assert.ok(
        paypalHelper.client.doReferenceTransaction.calledOnceWith(validOptions)
      );
    });

    it('it returns the data from doRequest', async () => {
      const expectedResponse = {
        amount: '1555555.99',
        avsCode: '',
        cvv2Match: '',
        orderTime: '2021-01-25T17:02:15Z',
        parentTransactionId: 'PAYID-MAHPTFI9KG0531222783101E',
        paymentStatus: 'Completed',
        paymentType: 'instant',
        pendingReason: 'None',
        reasonCode: 'None',
        transactionId: '51E835834L664664K',
        transactionType: 'merchtpmt',
      };
      paypalHelper.client.doRequest = sinon.fake.resolves(
        successfulDoReferenceTransactionResponse
      );
      const response = await paypalHelper.chargeCustomer(validOptions);
      assert.deepEqual(response, expectedResponse);
    });

    it('if doRequest unsuccessful, throws an error', async () => {
      paypalHelper.client.doRequest = sinon.fake.throws(
        new PayPalClientError('Fake', {})
      );
      try {
        await paypalHelper.chargeCustomer(validOptions);
        assert.fail('Request should have thrown an error.');
      } catch (err) {
        assert.instanceOf(err, PayPalClientError);
        assert.equal(err.name, 'PayPalClientError');
      }
    });
  });

  describe('verifyIpnMessage', () => {
    it('validates IPN message', async () => {
      paypalHelper.client.ipnVerify = sinon.fake.resolves('VERIFIED');
      const response = await paypalHelper.verifyIpnMessage(
        sampleIpnMessage.message
      );
      sinon.assert.calledOnceWithExactly(
        paypalHelper.client.ipnVerify,
        sampleIpnMessage.message
      );
      assert.isTrue(response);
    });

    it('invalidates IPN message', async () => {
      paypalHelper.client.ipnVerify = sinon.fake.resolves('INVALID');
      const response = await paypalHelper.verifyIpnMessage('invalid=True');
      sinon.assert.calledOnceWithExactly(
        paypalHelper.client.ipnVerify,
        'invalid=True'
      );
      assert.isFalse(response);
    });
  });

  describe('extractIpnMessage', () => {
    it('extracts IPN message from payload', () => {
      const msg = paypalHelper.extractIpnMessage(sampleIpnMessage.message);
      assert.deepEqual(msg, {
        address_city: 'San Jose',
        address_country: 'United States',
        address_country_code: 'US',
        address_name: 'Test User',
        address_state: 'CA',
        address_status: 'confirmed',
        address_street: '1 Main St',
        address_zip: '95131',
        charset: 'windows-1252',
        custom: '',
        first_name: 'Test',
        handling_amount: '0.00',
        item_name: '',
        item_number: '',
        last_name: 'User',
        mc_currency: 'USD',
        mc_fee: '0.88',
        mc_gross: '19.95',
        notify_version: '2.6',
        payer_email: 'gpmac_1231902590_per@paypal.com',
        payer_id: 'LPLWNMTBWMFAY',
        payer_status: 'verified',
        payment_date: '20:12:59 Jan 13, 2009 PST',
        payment_fee: '0.88',
        payment_gross: '19.95',
        payment_status: 'Completed',
        payment_type: 'instant',
        protection_eligibility: 'Eligible',
        quantity: '1',
        receiver_email: 'gpmac_1231902686_biz@paypal.com',
        receiver_id: 'S8XGHLYDW9T3S',
        residence_country: 'US',
        shipping: '0.00',
        tax: '0.00',
        test_ipn: '1',
        transaction_subject: '',
        txn_id: '61E67681CH3238416',
        txn_type: 'express_checkout',
        verify_sign: 'AtkOfCXbDm2hu0ZELryHFjY-Vb7PAUvS6nMXgysbElEn9v-1XcmSoGtf',
      });
    });
  });

  describe('processZeroInvoice', () => {
    it('finalize invoice that with no amount set to zero', async () => {
      mockStripeHelper.finalizeInvoice = sinon.fake.resolves({});
      mockStripeHelper.payInvoiceOutOfBand = sinon.fake.resolves({});
      const response = await paypalHelper.processZeroInvoice(mockInvoice);
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.finalizeInvoice,
        mockInvoice
      );
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.payInvoiceOutOfBand,
        mockInvoice
      );
      assert.deepEqual(response, [{}, {}]);
    });
  });

  describe('processInvoice', () => {
    const agreementId = 'agreement-id';
    const paymentAttempts = 0;
    const transactionId = 'transaction-id';

    it('runs a open invoice successfully', async () => {
      const validInvoice = {
        ...mockInvoice,
        status: 'open',
        amount_due: 4.99,
      };
      mockStripeHelper.getCustomerPaypalAgreement = sinon.fake.returns(
        agreementId
      );
      mockStripeHelper.getPaymentAttempts = sinon.fake.returns(paymentAttempts);
      paypalHelper.chargeCustomer = sinon.fake.resolves({
        paymentStatus: 'Completed',
        transactionId,
      });
      mockStripeHelper.updateInvoiceWithPaypalTransactionId = sinon.fake.resolves(
        { transactionId }
      );
      mockStripeHelper.payInvoiceOutOfBand = sinon.fake.resolves({});

      const response = await paypalHelper.processInvoice({
        customer: mockCustomer,
        invoice: validInvoice,
      });
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getCustomerPaypalAgreement,
        mockCustomer
      );
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getPaymentAttempts,
        validInvoice
      );
      sinon.assert.calledOnceWithExactly(paypalHelper.chargeCustomer, {
        amount: validInvoice.amount_due.toString(),
        billingAgreementId: agreementId,
        invoiceNumber: validInvoice.id,
        idempotencyKey: validInvoice.id + paymentAttempts,
      });
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.updateInvoiceWithPaypalTransactionId,
        validInvoice,
        transactionId
      );
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.payInvoiceOutOfBand,
        validInvoice
      );
      assert.deepEqual(response, [{ transactionId }, {}]);
    });

    it('runs a draft invoice successfully', async () => {
      const validInvoice = {
        ...mockInvoice,
        status: 'draft',
        amount_due: 4.99,
      };
      mockStripeHelper.getCustomerPaypalAgreement = sinon.fake.returns(
        agreementId
      );
      mockStripeHelper.finalizeInvoice = sinon.fake.resolves({});
      mockStripeHelper.getPaymentAttempts = sinon.fake.returns(paymentAttempts);
      paypalHelper.chargeCustomer = sinon.fake.resolves({
        paymentStatus: 'Completed',
        transactionId,
      });
      mockStripeHelper.updateInvoiceWithPaypalTransactionId = sinon.fake.resolves(
        { transactionId }
      );
      mockStripeHelper.payInvoiceOutOfBand = sinon.fake.resolves({});

      const response = await paypalHelper.processInvoice({
        customer: mockCustomer,
        invoice: validInvoice,
      });
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getCustomerPaypalAgreement,
        mockCustomer
      );
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getPaymentAttempts,
        validInvoice
      );
      sinon.assert.calledOnceWithExactly(paypalHelper.chargeCustomer, {
        amount: validInvoice.amount_due.toString(),
        billingAgreementId: agreementId,
        invoiceNumber: validInvoice.id,
        idempotencyKey: validInvoice.id + paymentAttempts,
      });
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.finalizeInvoice,
        validInvoice
      );
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.updateInvoiceWithPaypalTransactionId,
        validInvoice,
        transactionId
      );
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.payInvoiceOutOfBand,
        validInvoice
      );
      assert.deepEqual(response, [{ transactionId }, {}]);
    });

    it('runs invoice payment was Pending or In-Progress', async () => {
      const validInvoice = {
        ...mockInvoice,
        status: 'open',
        amount_due: 4.99,
      };
      mockStripeHelper.getCustomerPaypalAgreement = sinon.fake.returns(
        agreementId
      );
      mockStripeHelper.getPaymentAttempts = sinon.fake.returns(paymentAttempts);
      paypalHelper.chargeCustomer = sinon.fake.resolves({
        paymentStatus: 'Pending',
        transactionId,
      });

      const response = await paypalHelper.processInvoice({
        customer: mockCustomer,
        invoice: validInvoice,
      });
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getCustomerPaypalAgreement,
        mockCustomer
      );
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getPaymentAttempts,
        validInvoice
      );
      sinon.assert.calledOnceWithExactly(paypalHelper.chargeCustomer, {
        amount: validInvoice.amount_due.toString(),
        billingAgreementId: agreementId,
        invoiceNumber: validInvoice.id,
        idempotencyKey: validInvoice.id + paymentAttempts,
      });
      assert.equal(response, undefined);
    });

    it('throws error on invoice payment responded with Denied, Failed, Voided, or Expired', async () => {
      const validInvoice = {
        ...mockInvoice,
        status: 'open',
        amount_due: 4.99,
      };
      mockStripeHelper.getCustomerPaypalAgreement = sinon.fake.returns(
        agreementId
      );
      mockStripeHelper.getPaymentAttempts = sinon.fake.returns(paymentAttempts);
      paypalHelper.chargeCustomer = sinon.fake.resolves({
        paymentStatus: 'Denied',
        transactionId,
      });
      mockStripeHelper.updatePaymentAttempts = sinon.fake.resolves({});

      try {
        await paypalHelper.processInvoice({
          customer: mockCustomer,
          invoice: validInvoice,
        });
        assert.fail(
          'Error should throw unexpected PayPal transaction response.'
        );
      } catch (err) {
        assert.deepEqual(err, error.paymentFailed());
      }
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getCustomerPaypalAgreement,
        mockCustomer
      );
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getPaymentAttempts,
        validInvoice
      );
      sinon.assert.calledOnceWithExactly(paypalHelper.chargeCustomer, {
        amount: validInvoice.amount_due.toString(),
        billingAgreementId: agreementId,
        invoiceNumber: validInvoice.id,
        idempotencyKey: validInvoice.id + paymentAttempts,
      });
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.updatePaymentAttempts,
        validInvoice
      );
    });

    it('logs and throws error on invoice payment responded with unexpected PayPal payment status', async () => {
      const paymentStatus = 'Unexpected';
      const validInvoice = {
        ...mockInvoice,
        status: 'open',
        amount_due: 4.99,
      };
      mockStripeHelper.getCustomerPaypalAgreement = sinon.fake.returns(
        agreementId
      );
      mockStripeHelper.getPaymentAttempts = sinon.fake.returns(paymentAttempts);
      paypalHelper.log = { error: sinon.fake.returns({}) };
      paypalHelper.chargeCustomer = sinon.fake.resolves({
        paymentStatus,
        transactionId,
      });

      try {
        await paypalHelper.processInvoice({
          customer: mockCustomer,
          invoice: validInvoice,
        });
        assert.fail(
          'Error should throw unexpected PayPal transaction response.'
        );
      } catch (err) {
        assert.deepEqual(
          err,
          error.internalValidationError('processInvoice', {
            message: 'Unexpected PayPal transaction response.',
            transactionResponse: paymentStatus,
          })
        );
      }
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getCustomerPaypalAgreement,
        mockCustomer
      );
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getPaymentAttempts,
        validInvoice
      );
      sinon.assert.calledOnceWithExactly(paypalHelper.chargeCustomer, {
        amount: validInvoice.amount_due.toString(),
        billingAgreementId: agreementId,
        invoiceNumber: validInvoice.id,
        idempotencyKey: validInvoice.id + paymentAttempts,
      });
    });

    it('throws error for invoice without PayPal Billing Agreement ID', async () => {
      mockStripeHelper.getCustomerPaypalAgreement = sinon.fake.returns(
        undefined
      );

      try {
        await paypalHelper.processInvoice({
          customer: mockCustomer,
          invoice: mockInvoice,
        });
        assert.fail('Error should throw agreement ID not found.');
      } catch (err) {
        assert.deepEqual(
          err,
          error.internalValidationError('processInvoice', {
            message: 'Agreement ID not found.',
          })
        );
      }
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getCustomerPaypalAgreement,
        mockCustomer
      );
    });

    it('throws error for invoice not on draft or open status', async () => {
      const validInvoice = {
        ...mockInvoice,
        status: 'paid',
      };

      mockStripeHelper.getCustomerPaypalAgreement = sinon.fake.returns(
        agreementId
      );

      try {
        await paypalHelper.processInvoice({
          customer: mockCustomer,
          invoice: validInvoice,
        });
        assert.fail('Error should throw invoice in invalid state.');
      } catch (err) {
        assert.deepEqual(
          err,
          error.internalValidationError('processInvoice', {
            message: 'Invoice in invalid state.',
          })
        );
      }
      sinon.assert.calledOnceWithExactly(
        mockStripeHelper.getCustomerPaypalAgreement,
        mockCustomer
      );
    });
  });
});
