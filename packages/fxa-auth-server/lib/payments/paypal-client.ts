/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import pRetry from 'p-retry';
import querystring from 'querystring';
import superagent from 'superagent';

export const PAYPAL_SANDBOX_BASE = 'https://api-3t.sandbox.paypal.com';
export const PAYPAL_SANDBOX_IPN_BASE = 'https://ipnpb.sandbox.paypal.com';
export const PAYPAL_LIVE_BASE = 'https://api-3t.paypal.com';
export const PAYPAL_LIVE_IPN_BASE = 'https://ipnpb.paypal.com';
export const PAYPAL_NVP_ROUTE = '/nvp';
export const PAYPAL_IPN_ROUTE = '/cgi-bin/webscr';
export const PAYPAL_SANDBOX_API = PAYPAL_SANDBOX_BASE + PAYPAL_NVP_ROUTE;
export const PAYPAL_LIVE_API = PAYPAL_LIVE_BASE + PAYPAL_NVP_ROUTE;
export const PAYPAL_SANDBOX_IPN = PAYPAL_SANDBOX_IPN_BASE + PAYPAL_IPN_ROUTE;
export const PAYPAL_LIVE_IPN = PAYPAL_LIVE_IPN_BASE + PAYPAL_IPN_ROUTE;
// See https://developer.paypal.com/docs/checkout/reference/upgrade-integration/#nvp-integrations
// for information on when to use PLACEHOLDER_URL
export const PLACEHOLDER_URL = 'https://www.paypal.com/checkoutnow/error';
const PAYPAL_VERSION = '204';
const L_LIST = /L_([A-Z]+)(\d+)$/;

type PaypalOptions = {
  sandbox: boolean;
  user: string;
  pwd: string;
  signature: string;
  retryOptions?: {
    retries?: number;
    minTimeout?: number;
    factor?: number;
  };
};

export type PAYPAL_METHODS =
  | 'BillAgreementUpdate'
  | 'CreateBillingAgreement'
  | 'DoReferenceTransaction'
  | 'GetTransactionDetails'
  | 'SetExpressCheckout'
  | 'TransactionSearch';

/*
 * Common response fields
 * https://developer.paypal.com/docs/nvp-soap-api/NVPAPIOverview/#common-response-fields
 */

export type PAYPAL_NVP_ACK_OPTIONS =
  | 'Success'
  | 'SuccessWithWarning'
  | 'Failure'
  | 'FailureWithWarning';

type NVPResponse = {
  ACK: PAYPAL_NVP_ACK_OPTIONS;
  BUILD: string;
  CORRELATIONID: string;
  TIMESTAMP: string;
  VERSION: string;
};

type SetExpressCheckoutData = {
  TOKEN: string;
};

type CreateBillingAgreementData = {
  BILLINGAGREEMENTID: string;
};

type DoReferenceTransactionData = {
  AMT: string;
  AVSCODE: string;
  BILLINGAGREEMENTID: string;
  CURRENCYCODE: string;
  CVV2MATCH: string;
  FEEAMT: string;
  ORDERTIME: string;
  PARENTTRANSACTIONID: string;
  PAYMENTSTATUS: string;
  PAYMENTTYPE: string;
  PENDINGREASON: string;
  PROTECTIONELIGIBILITY: string;
  PROTECTIONELIGIBILITYTYPE: string;
  REASONCODE: string;
  TAXAMT: string;
  TRANSACTIONID: string;
  TRANSACTIONTYPE: string;
};

type BAUpdateData = {
  BILLINGAGREEMENTID: string;
  BILLINGAGREEMENTSTATUS: string;
  COUNTRYCODE: string;
  EMAIL: string;
  PAYERSTATUS: string;
};

export type NVPSetExpressCheckoutResponse = NVPResponse &
  SetExpressCheckoutData;

export type NVPCreateBillingAgreementResponse = NVPResponse &
  CreateBillingAgreementData;

export type NVPDoReferenceTransactionResponse = NVPResponse &
  DoReferenceTransactionData;

export type NVPBAUpdateTransactionResponse = NVPResponse & BAUpdateData;

export type CreateBillingAgreementOptions = {
  token: string;
};

export type DoReferenceTransactionOptions = {
  amount: string;
  billingAgreementId: string;
  invoiceNumber: string;
  idempotencyKey: string;
};

export type BAUpdateOptions = {
  billingAgreementId: string;
};

export type IpnMessage = {
  txn_type: string;
  [key: string]: any;
};

export type IpnMerchPmtType = IpnMessage & {
  invoice: string;
  // The billing agreement ID
  mp_id: string;
  mc_gross: string;
  mp_notification?: any;
  mp_pay_type: 'INSTANT' | 'ANY' | 'ECHECK';
  // Agreement status, A for Active, I for inactive
  // I is equivalent to cancelled.
  mp_status: 'A' | 'I';
  txn_id: string;
  txn_type: 'merch_pmt' | 'mp_cancel';
};

/**
 * Type Guard to indicate whether the given IPN Message is a Merchant Payment
 * message.
 *
 * @param ipnMessage
 */
export function isIpnMerchPmt(
  ipnMessage: IpnMessage
): ipnMessage is IpnMerchPmtType {
  return ['merch_pmt', 'mp_cancel'].includes(ipnMessage.txn_type);
}

export class PayPalClientError extends Error {
  public raw: string;
  public data: NVPResponse;

  constructor(raw: string, data: NVPResponse, ...params: any) {
    super(...params);
    this.name = 'PayPalClientError';
    if (!this.message) {
      this.message =
        'PayPal NVP returned a non-success ACK. See "this.raw" or "this.data" for more details.';
    }
    this.raw = raw;
    this.data = data;
  }
}
export class PayPalClient {
  private url: string;
  private ipnUrl: string;
  private user: string;
  private pwd: string;
  private signature: string;
  private retryOptions: {
    retries: number;
    minTimeout: number;
    factor: number;
  };

  constructor(options: PaypalOptions) {
    this.url = options.sandbox ? PAYPAL_SANDBOX_API : PAYPAL_LIVE_API;
    this.ipnUrl = options.sandbox ? PAYPAL_SANDBOX_IPN : PAYPAL_LIVE_IPN;
    this.user = options.user;
    this.pwd = options.pwd;
    this.signature = options.signature;
    this.retryOptions = {
      retries: 3,
      minTimeout: 500,
      factor: 1.66,
      ...options.retryOptions,
    };
  }

  private objectToNVP(object: Record<string, any>): string {
    return querystring.stringify(object);
  }

  public nvpToObject(payload: string): Record<string, any> {
    const object = querystring.parse(payload, undefined, undefined, {
      maxKeys: 0,
    });
    const result: Record<string, any> = {};
    const lst: any[] = [];
    for (const [key, value] of Object.entries(object)) {
      const match = key.match(L_LIST);
      if (!match) {
        result[key] = value;
        continue;
      }
      const [name, indexString] = [match[1], match[2]];
      const index = parseInt(indexString);

      if (!lst[index]) {
        lst[index] = {};
      }
      lst[index][name] = value;
    }
    if (lst.length !== 0) {
      result['L'] = lst;
    }
    return result;
  }

  private async doRequest<T extends NVPResponse>(
    method: PAYPAL_METHODS,
    data: Record<string, any>
  ): Promise<T> {
    const payload = this.objectToNVP({
      ...data,
      USER: this.user,
      METHOD: method,
      PWD: this.pwd,
      SIGNATURE: this.signature,
      VERSION: PAYPAL_VERSION,
    });
    const result = await pRetry(
      () =>
        superagent
          .post(this.url)
          .set('content-type', 'application/x-www-form-urlencoded')
          .send(payload),
      this.retryOptions
    );
    const resultObj = this.nvpToObject(result.text) as T;
    if (resultObj.ACK === 'Success' || resultObj.ACK === 'SuccessWithWarning') {
      return resultObj;
    } else {
      throw new PayPalClientError(result.text, resultObj);
    }
  }

  /**
   * Call the Paypal SetExpressCheckout NVP API
   *
   * Using the Paypal SetExpressCheckout API (https://developer.paypal.com/docs/nvp-soap-api/set-express-checkout-nvp/)
   * we get back the response which contains a token that we can use in the next step of the transaction.
   * The API is extensive. Currently this method only supports the situation where you're getting an authorizing
   * token that allows us to perform billing in the future.
   */
  public async setExpressCheckout(): Promise<NVPSetExpressCheckoutResponse> {
    const data = {
      CANCELURL: PLACEHOLDER_URL,
      L_BILLINGAGREEMENTDESCRIPTION0: 'Mozilla',
      L_BILLINGTYPE0: 'MerchantInitiatedBilling',
      NOSHIPPING: 1,
      PAYMENTREQUEST_0_AMT: '0',
      PAYMENTREQUEST_0_CURRENCYCODE: 'USD',
      PAYMENTREQUEST_0_PAYMENTACTION: 'AUTHORIZATION',
      RETURNURL: PLACEHOLDER_URL,
    };
    return await this.doRequest<NVPSetExpressCheckoutResponse>(
      'SetExpressCheckout',
      data
    );
  }

  /**
   * Call the Paypal CreateBillingAgreement NVP API
   *
   * Using the Paypal CreateBillingAgreement API (https://developer.paypal.com/docs/nvp-soap-api/create-billing-agreement-nvp/)
   * creates a billing agreement using the time-stamped token returned in the SetExpressCheckout response.
   */
  public async createBillingAgreement(
    options: CreateBillingAgreementOptions
  ): Promise<NVPCreateBillingAgreementResponse> {
    return await this.doRequest<NVPCreateBillingAgreementResponse>(
      'CreateBillingAgreement',
      options
    );
  }

  /**
   * Call the Paypal DoReferenceTransaction NVP API
   *
   * Using the Paypal DoReferenceTransaction API (https://developer.paypal.com/docs/nvp-soap-api/do-reference-transaction-nvp/)
   * we charge the customer based on a pre-existing billing agreement.
   * The API is extensive, we only support the one workflow of pre-existing billing
   * agreement.
   *
   * The amount, that is passed in with options should be a formatted string of USD
   * that is acceptable to PayPal.
   */
  public async doReferenceTransaction(
    options: DoReferenceTransactionOptions
  ): Promise<NVPDoReferenceTransactionResponse> {
    const data = {
      AMT: options.amount,
      INVNUM: options.invoiceNumber,
      MSGSUBID: options.idempotencyKey,
      PAYMENTACTION: 'Sale',
      PAYMENTTYPE: 'instant',
      REFERENCEID: options.billingAgreementId,
    };
    return await this.doRequest<NVPDoReferenceTransactionResponse>(
      'DoReferenceTransaction',
      data
    );
  }

  /**
   * Call the PayPal BillAgreementUpdate NVP API
   *
   * Using the PayPal BillAgreementUpdate API (https://developer.paypal.com/docs/nvp-soap-api/ba-update-nvp/)
   * we get the information on the PayPal user such as the country code.
   */
  public async baUpdate(
    options: BAUpdateOptions
  ): Promise<NVPBAUpdateTransactionResponse> {
    const data = {
      REFERENCEID: options.billingAgreementId,
    };
    return await this.doRequest<NVPBAUpdateTransactionResponse>(
      'BillAgreementUpdate',
      data
    );
  }

  /**
   * Call the PayPal IPN/PDT message verification endpoint.
   *
   * Verifies a PayPal IPN/PDT message body by posting it back to PayPal per
   * the IPN listener request-response flow
   * (https://developer.paypal.com/docs/api-basics/notifications/ipn/IPNImplementation/#ipn-listener-request-response-flow).
   *
   * @param message
   */
  public async ipnVerify(message: string): Promise<string> {
    const verifyBody = 'cmd=_notify-validate&' + message;
    const result = await pRetry(() =>
      superagent.post(this.ipnUrl).send(verifyBody)
    );
    return result.text;
  }
}
