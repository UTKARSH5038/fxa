/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import React from 'react';
import {
  InMemoryCache,
  ApolloClient,
  ApolloProvider,
  DocumentNode,
} from '@apollo/client';
import { MockLink, MockedResponse } from '@apollo/client/testing';
import { Account } from '.';
import { GET_INITIAL_STATE } from '../components/App';
import { deepMerge } from '../lib/utilities';
import {
  createHistory,
  createMemorySource,
  LocationProvider,
} from '@reach/router';
import { render } from '@testing-library/react';
import {
  GET_ACCOUNT,
  GET_RECOVERY_KEY_EXISTS,
  GET_TOTP_STATUS,
} from './Account';
import { typeDefs } from '../lib/cache';
import AppLocalizationProvider from 'fxa-react/lib/AppLocalizationProvider';
import waitUntil from 'async-wait-until';
import sinon from 'sinon';
import path from 'path';
import fs from 'fs';
import fetchMock from 'fetch-mock';

export const MOCK_ACCOUNT: Account = {
  uid: 'abc123',
  displayName: 'John Dope',
  avatarUrl: 'http://placekitten.com/512/512',
  accountCreated: 123456789,
  passwordCreated: 123456789,
  recoveryKey: true,
  attachedClients: [],
  subscriptions: [],
  primaryEmail: {
    email: 'johndope@example.com',
    isPrimary: true,
    verified: true,
  },
  emails: [
    {
      email: 'johndope@example.com',
      isPrimary: true,
      verified: true,
    },
  ],
  totp: {
    exists: true,
    verified: true,
  },
  alertTextExternal: null,
};

export interface MockedProps {
  account?: Hash<any>;
  verified?: boolean;
  childProps?: object;
  children?: React.ReactElement;
  mocks?: MockedResponse<Record<string, any>>[];
}
export interface MockedState {
  client: ApolloClient<any>;
}

/**
 * Create an InMemoryCache using MOCK_ACCOUNT and optional overrides
 */
export function createCache({
  account = {},
  verified = true,
}: MockedProps = {}) {
  const cache = new InMemoryCache({
    typePolicies: {
      Account: {
        keyFields: [],
      },
    },
  });
  cache.writeQuery({
    query: GET_INITIAL_STATE,
    data: {
      account: deepMerge({}, MOCK_ACCOUNT, account, { __typename: 'Account' }),
      session: {
        verified,
        __typename: 'Session',
      },
    },
  });
  return cache;
}

/**
 * MockedCache is a sugary sweet version of MockedProvider.
 *
 * By default it uses values from MOCK_ACCOUNT but can be overwritten via props
 * `account` and `verified`. It also takes in an optional `mocks` property.
 *
 * Example:
 * ```
 * <MockedCache account={{displayName: 'Marceline'}}>
 *   <CoolComponent/>
 * </MockedCache>
 * ```
 *
 * If you need more knobs use MockedProvider instead.
 *
 * Using:
 * ```
 * <MockedCache>
 *  <CoolComponent/>
 * </MockedCache>
 * ```
 *
 * is equivalent to:
 * ```
 * const cache = new InMemoryCache()
 * cache.writeQuery({
 *   query: GET_INITIAL_STATE,
 *   data: {
 *     account: MOCK_ACCOUNT,
 *     session: { verified: true }
 *   }
 * })
 * <MockedProvider cache={cache}>
 *   <CoolComponent/>
 * </MockedProvider>
 * ```
 */
export class MockedCache extends React.Component<MockedProps, MockedState> {
  constructor(props: MockedProps) {
    super(props);
    this.state = {
      client: new ApolloClient({
        cache: createCache(props),
        link: new MockLink(props.mocks || [], true),
        typeDefs: typeDefs,
      }),
    };
  }

  render() {
    const { children, childProps } = this.props;
    return children ? (
      <ApolloProvider client={this.state.client}>
        {React.cloneElement(React.Children.only(children), { ...childProps })}
      </ApolloProvider>
    ) : null;
  }

  componentWillUnmount() {
    this.state.client.stop();
  }
}

export function renderWithRouter(
  ui: any,
  { route = '/', history = createHistory(createMemorySource(route)) } = {}
) {
  return {
    ...render(<LocationProvider {...{ history }}>{ui}</LocationProvider>),
    history,
  };
}

const settingsFtlPath = path.resolve(
  __dirname,
  '..',
  '../public/locales/en-US/settings.ftl'
);
fetchMock.get(
  '/locales/en-US/settings.ftl',
  fs.readFileSync(settingsFtlPath, 'utf-8')
);
fetchMock.get(
  '/locales/en-GB/settings.ftl',
  fs.readFileSync(settingsFtlPath, 'utf-8')
);
fetchMock.get(
  '/locales/en/settings.ftl',
  fs.readFileSync(settingsFtlPath, 'utf-8')
);
export async function renderWithRouterAndLocalization(
  ui: any,
  { route = '/', history = createHistory(createMemorySource(route)) } = {}
) {
  sinon.spy(AppLocalizationProvider.prototype, 'render');
  const renderResult = {
    ...render(
      <AppLocalizationProvider bundles={['settings']} userLocales={['en-US']}>
        <LocationProvider {...{ history }}>{ui}</LocationProvider>
      </AppLocalizationProvider>
    ),
    history,
  };
  await waitUntil(() => {
    return (
      (AppLocalizationProvider.prototype.render as sinon.SinonSpy).callCount ===
      2
    );
  });
  // @ts-ignore
  AppLocalizationProvider.prototype.render.restore();

  return renderResult;
}

export const mockEmail = (
  email: string,
  isPrimary = true,
  verified = true
) => ({
  email,
  isPrimary,
  verified,
});

export const mockAccountQuery = (
  modifications: { [key: string]: any } = {}
) => {
  return {
    request: {
      query: GET_ACCOUNT,
    },
    result: {
      data: {
        account: Object.assign(MOCK_ACCOUNT, modifications, {
          __typename: 'Account',
        }),
      },
    },
  };
};

export const mockRecoveryKeyExistsQuery = (
  mockedData: { recoveryKey: boolean } = { recoveryKey: false }
) => ({
  request: {
    query: GET_RECOVERY_KEY_EXISTS,
  },
  result: {
    data: { account: { ...mockedData, __typename: 'Account' } },
  },
});

export const mockTotpStatusQuery = (
  mockedData: { totp: { exists: boolean; verified: boolean } } = {
    totp: { exists: false, verified: false },
  }
) => ({
  request: {
    query: GET_TOTP_STATUS,
  },
  result: {
    data: { account: { ...mockedData, __typename: 'Account' } },
  },
});
