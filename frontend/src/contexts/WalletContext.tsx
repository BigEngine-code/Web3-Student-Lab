'use client';

import {
  getAddress as getFreighterAddress,
  isConnected as isFreighterConnected,
  requestAccess as requestFreighterAccess,
  signTransaction as signFreighterTransaction,
} from '@stellar/freighter-api';
import { useMachine } from '@xstate/react';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  web3TransactionMachine,
  type Web3TransactionContext,
  type Web3TransactionStatus,
} from '@/lib/web3/transactionMachine';
import { authAPI } from '@/lib/api';

export type StellarNetwork = 'PUBLIC' | 'TESTNET' | 'FUTURENET';

export const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  PUBLIC: 'Public Global Stellar Network ; September 2015',
  TESTNET: 'Test SDF Network ; September 2015',
  FUTURENET: 'Test SDF Future Network ; October 2022',
};

export interface WalletProvider {
  id: string;
  name: string;
  icon: string;
  downloadUrl: string;
  description: string;
  isInstalled: () => boolean;
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
  getPublicKey: () => Promise<string | null>;
  getNetwork?: () => Promise<StellarNetwork | string | null>;
  switchNetwork?: (network: StellarNetwork) => Promise<boolean>;
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
  onAccountChange?: (cb: (pk: string | null) => void) => () => void;
  onNetworkChange?: (cb: (net: StellarNetwork | string) => void) => () => void;
}

declare global {
  interface Window {
    freighter?: {
      isConnected: () => Promise<boolean | { isConnected: boolean; error?: string }>;
      requestAccess?: () => Promise<{ address: string; error?: string }>;
      getAddress?: () => Promise<{ address: string; error?: string }>;
      getPublicKey?: () => Promise<string>;
      getNetwork?: () => Promise<string>;
      setNetwork?: (network: string) => Promise<boolean>;
      signTransaction: (
        xdr: string,
        opts?: object
      ) => Promise<string | { signedTxXdr: string; signerAddress: string; error?: string }>;
    };
    freighterApi?: {
      isConnected?: () => Promise<boolean | { isConnected: boolean; error?: string }>;
      requestAccess?: () => Promise<{ address: string; error?: string }>;
      getAddress?: () => Promise<{ address: string; error?: string }>;
      getPublicKey?: () => Promise<string>;
      getNetwork?: () => Promise<string>;
      signTransaction: (
        xdr: string,
        opts?: object
      ) => Promise<string | { signedTxXdr: string; signerAddress: string; error?: string }>;
    };
    stellar?: {
      freighter?: {
        isConnected?: () => Promise<boolean | { isConnected: boolean; error?: string }>;
        requestAccess?: () => Promise<{ address: string; error?: string }>;
        getAddress?: () => Promise<{ address: string; error?: string }>;
        getPublicKey?: () => Promise<string>;
        getNetwork?: () => Promise<string>;
        signTransaction: (
          xdr: string,
          opts?: object
        ) => Promise<string | { signedTxXdr: string; signerAddress: string; error?: string }>;
      };
      hana?: {
        connect: () => Promise<{ publicKey: string }>;
        getPublicKey: () => Promise<string>;
        signTransaction: (xdr: string) => Promise<string>;
      };
    };
    albedo?: {
      publicKey: (opts?: object) => Promise<{ pubkey: string }>;
      tx: (opts: { xdr: string; network: string }) => Promise<{ signed_envelope_xdr: string }>;
    };
    rabet?: {
      connect: () => Promise<{ publicKey: string }>;
      sign: (xdr: string, network: string) => Promise<{ xdr: string }>;
    };
    hana?: {
      connect: () => Promise<{ publicKey: string }>;
      getPublicKey: () => Promise<string>;
      signTransaction: (xdr: string) => Promise<string>;
    };
    xBull?: {
      connect: () => Promise<{ publicKey: string }>;
      getPublicKey: () => Promise<string>;
      sign: (xdr: string, opts?: object) => Promise<string>;
    };
    xBullSDK?: {
      connect: () => Promise<{ publicKey: string }>;
      getPublicKey: () => Promise<string>;
      sign: (xdr: string, opts?: object) => Promise<string>;
    };
    walletConnect?: {
      connect: () => Promise<{ account: string }>;
      sign: (xdr: string) => Promise<string>;
    };
  }
}

const resolveInjectedFreighter = () =>
  typeof window === 'undefined'
    ? null
    : window.freighterApi || window.freighter || window.stellar?.freighter || null;

const freighterAdapter: WalletProvider = {
  id: 'freighter',
  name: 'Freighter',
  icon: '🚀',
  downloadUrl: 'https://www.freighter.app',
  description: 'Browser extension wallet for the Stellar network.',
  isInstalled: () =>
    typeof window !== 'undefined' &&
    (!!window.freighter || !!window.freighterApi || !!window.stellar?.freighter),
  connect: async () => {
    let access;
    try {
      access = await requestFreighterAccess();
    } catch (e) {
      throw new Error('Failed to request access from Freighter. Make sure the extension is unlocked and enabled for this site.');
    }
    
    if (!access || access.error || !access.address) {
      throw new Error(access?.error || 'Freighter did not return an address. Please unlock your wallet and try again.');
    }

    return access.address;
  },
  disconnect: async () => {},
  getPublicKey: async () => {
    const injected = resolveInjectedFreighter();
    if (injected?.getAddress) {
      const injectedAddress = await injected.getAddress();
      return injectedAddress.error || !injectedAddress.address ? null : injectedAddress.address;
    }
    if (injected?.getPublicKey) {
      return injected.getPublicKey();
    }

    const address = await getFreighterAddress();
    if (address.error || !address.address) {
      return null;
    }

    return address.address;
  },
  getNetwork: async () => {
    const injected = resolveInjectedFreighter();
    if (injected?.getNetwork) {
      try {
        const net = await injected.getNetwork();
        const upper = net.toUpperCase();
        if (upper.includes('PUBLIC') || upper.includes('MAIN')) return 'PUBLIC';
        if (upper.includes('FUTURE')) return 'FUTURENET';
        return 'TESTNET';
      } catch {
        return 'TESTNET';
      }
    }
    return 'TESTNET';
  },
  switchNetwork: async (network: StellarNetwork) => {
    if (window.freighter?.setNetwork) {
      try {
        return await window.freighter.setNetwork(network);
      } catch {
        return false;
      }
    }
    return false;
  },
  signTransaction: async (xdr: string, opts?: { networkPassphrase?: string }) => {
    const injected = resolveInjectedFreighter();
    if (injected?.signTransaction) {
      const result = await injected.signTransaction(xdr, opts);
      if (typeof result === 'string') {
        return result;
      }
      if (result.error || !result.signedTxXdr) {
        throw new Error(result.error || 'Freighter could not sign the transaction');
      }
      return result.signedTxXdr;
    }

    const result = await signFreighterTransaction(xdr, opts);
    if (result.error || !result.signedTxXdr) {
      throw new Error(result.error || 'Freighter could not sign the transaction');
    }

    return result.signedTxXdr;
  },
};

const albedoAdapter: WalletProvider = {
  id: 'albedo',
  name: 'Albedo',
  icon: '🌐',
  downloadUrl: 'https://albedo.link',
  description: 'Web-based delegated signing key management for Stellar.',
  isInstalled: () => true,
  connect: async () => {
    if (!window.albedo) throw new Error('Albedo not available');
    const res = await window.albedo.publicKey({});
    return res.pubkey;
  },
  disconnect: async () => {},
  getPublicKey: async () => {
    if (!window.albedo) return null;
    try {
      const res = await window.albedo.publicKey({});
      return res.pubkey;
    } catch {
      return null;
    }
  },
  getNetwork: async () => 'TESTNET',
  signTransaction: async (xdr: string, opts?: { networkPassphrase?: string }) => {
    if (!window.albedo) throw new Error('Albedo not available');
    const net = opts?.networkPassphrase?.includes('Public') ? 'public' : 'testnet';
    const res = await window.albedo.tx({ xdr, network: net });
    return res.signed_envelope_xdr;
  },
};

const rabetAdapter: WalletProvider = {
  id: 'rabet',
  name: 'Rabet',
  icon: '🔷',
  downloadUrl: 'https://rabet.io',
  description: 'Lightweight browser extension wallet for Stellar.',
  isInstalled: () => typeof window !== 'undefined' && !!window.rabet,
  connect: async () => {
    if (!window.rabet) throw new Error('Rabet not installed');
    const res = await window.rabet.connect();
    return res.publicKey;
  },
  disconnect: async () => {},
  getPublicKey: async () => {
    if (!window.rabet) return null;
    try {
      const res = await window.rabet.connect();
      return res.publicKey;
    } catch {
      return null;
    }
  },
  getNetwork: async () => 'TESTNET',
  signTransaction: async (xdr: string, opts?: { networkPassphrase?: string }) => {
    if (!window.rabet) throw new Error('Rabet not installed');
    const net = opts?.networkPassphrase?.includes('Public') ? 'PUBLIC' : 'TESTNET';
    const res = await window.rabet.sign(xdr, net);
    return res.xdr;
  },
};

const hanaAdapter: WalletProvider = {
  id: 'hana',
  name: 'Hana',
  icon: '🌸',
  downloadUrl: 'https://hanawallet.io',
  description: 'Multi-chain non-custodial Web3 wallet extension.',
  isInstalled: () => typeof window !== 'undefined' && (!!window.hana || !!window.stellar?.hana),
  connect: async () => {
    const provider = window.hana || window.stellar?.hana;
    if (!provider) throw new Error('Hana wallet is not installed');
    const res = await provider.connect();
    return res.publicKey;
  },
  disconnect: async () => {},
  getPublicKey: async () => {
    const provider = window.hana || window.stellar?.hana;
    if (!provider) return null;
    try {
      return await provider.getPublicKey();
    } catch {
      return null;
    }
  },
  getNetwork: async () => 'TESTNET',
  signTransaction: async (xdr: string) => {
    const provider = window.hana || window.stellar?.hana;
    if (!provider) throw new Error('Hana wallet is not installed');
    return await provider.signTransaction(xdr);
  },
};

const xBullAdapter: WalletProvider = {
  id: 'xbull',
  name: 'xBull',
  icon: '🐂',
  downloadUrl: 'https://xbull.app',
  description: 'Powerful privacy-focused Stellar extension wallet.',
  isInstalled: () => typeof window !== 'undefined' && (!!window.xBull || !!window.xBullSDK),
  connect: async () => {
    const provider = window.xBull || window.xBullSDK;
    if (!provider) throw new Error('xBull wallet is not installed');
    const res = await provider.connect();
    return res.publicKey;
  },
  disconnect: async () => {},
  getPublicKey: async () => {
    const provider = window.xBull || window.xBullSDK;
    if (!provider) return null;
    try {
      return await provider.getPublicKey();
    } catch {
      return null;
    }
  },
  getNetwork: async () => 'TESTNET',
  signTransaction: async (xdr: string, opts?: { networkPassphrase?: string }) => {
    const provider = window.xBull || window.xBullSDK;
    if (!provider) throw new Error('xBull wallet is not installed');
    return await provider.sign(xdr, opts);
  },
};

const walletConnectAdapter: WalletProvider = {
  id: 'walletconnect',
  name: 'WalletConnect',
  icon: '🔗',
  downloadUrl: 'https://walletconnect.com',
  description: 'Open protocol connecting mobile wallets with Web3 apps.',
  isInstalled: () => true,
  connect: async () => {
    if (window.walletConnect) {
      const res = await window.walletConnect.connect();
      return res.account;
    }
    return 'GBRPYHIL2CI3FYQMWVUGE62KMGOBQKLCYJ3HLKBUBIW5VZH4S4MNOWT';
  },
  disconnect: async () => {},
  getPublicKey: async () => {
    if (window.walletConnect) {
      const res = await window.walletConnect.connect();
      return res.account;
    }
    return 'GBRPYHIL2CI3FYQMWVUGE62KMGOBQKLCYJ3HLKBUBIW5VZH4S4MNOWT';
  },
  getNetwork: async () => 'TESTNET',
  signTransaction: async (xdr: string) => {
    if (window.walletConnect) {
      return await window.walletConnect.sign(xdr);
    }
    return xdr;
  },
};

const mockAdapter: WalletProvider = {
  id: 'mock',
  name: 'Dev Mock Wallet',
  icon: '🛠️',
  downloadUrl: 'https://stellar.org',
  description: 'Development sandbox wallet for isolated local testing.',
  isInstalled: () => true,
  connect: async () => 'GBRPYHIL2CI3FYQMWVUGE62KMGOBQKLCYJ3HLKBUBIW5VZH4S4MNOWT',
  disconnect: async () => {},
  getPublicKey: async () => 'GBRPYHIL2CI3FYQMWVUGE62KMGOBQKLCYJ3HLKBUBIW5VZH4S4MNOWT',
  getNetwork: async () => 'TESTNET',
  signTransaction: async (xdr) => xdr,
};

export const WALLET_PROVIDERS: WalletProvider[] = [
  freighterAdapter,
  albedoAdapter,
  rabetAdapter,
  hanaAdapter,
  xBullAdapter,
  walletConnectAdapter,
  mockAdapter,
];

interface WalletContextType {
  publicKey: string | null;
  activeWallet: string | null;
  isConnecting: boolean;
  isConnected: boolean;
  connected: boolean;
  error: string | null;
  activeNetwork: StellarNetwork;
  walletNetwork: StellarNetwork | null;
  isNetworkDivergent: boolean;
  blockHeight: number | null;
  balances: Record<StellarNetwork, string>;
  availableWallets: WalletProvider[];
  detectedWallets: WalletProvider[];
  transactionState: Web3TransactionStatus;
  transactionContext: Web3TransactionContext;
  connect: (providerName: string) => Promise<void>;
  authenticateWithWallet: (providerName: string) => Promise<any>;
  disconnect: () => Promise<void>;
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
  switchNetwork: (network: StellarNetwork) => Promise<void>;
  setAppNetwork: (network: StellarNetwork) => void;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [activeWallet, setActiveWallet] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeNetwork, setActiveNetwork] = useState<StellarNetwork>('TESTNET');
  const [walletNetwork, setWalletNetwork] = useState<StellarNetwork | null>(null);
  const [blockHeight, setBlockHeight] = useState<number | null>(4819200);
  const [detectedWallets, setDetectedWallets] = useState<WalletProvider[]>([]);
  const [transactionSnapshot, sendTransaction] = useMachine(web3TransactionMachine);

  const [balances, setBalances] = useState<Record<StellarNetwork, string>>({
    PUBLIC: '0.0000000 XLM',
    TESTNET: '10000.0000000 XLM (Testnet)',
    FUTURENET: '1000.0000000 XLM (Futurenet)',
  });

  const scanWallets = useCallback(() => {
    const installed = WALLET_PROVIDERS.filter((p) => p.isInstalled());
    setDetectedWallets(installed);
  }, []);

  useEffect(() => {
    scanWallets();
    const timer = setInterval(scanWallets, 3000);
    return () => clearInterval(timer);
  }, [scanWallets]);

  useEffect(() => {
    const interval = setInterval(() => {
      setBlockHeight((prev) => (prev !== null ? prev + 1 : 4819200));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem('stellar_wallet');
    if (saved) {
      try {
        const { wallet, pk, network } = JSON.parse(saved);
        setActiveWallet(wallet);
        setPublicKey(pk);
        if (network && ['PUBLIC', 'TESTNET', 'FUTURENET'].includes(network)) {
          setActiveNetwork(network);
        }
        sendTransaction({ type: 'WALLET_CONNECTED', walletName: wallet, publicKey: pk });
      } catch {
        localStorage.removeItem('stellar_wallet');
      }
    }
  }, [sendTransaction]);

  const updateWalletNetwork = useCallback(async (provider: WalletProvider) => {
    if (provider.getNetwork) {
      try {
        const net = await provider.getNetwork();
        if (net && ['PUBLIC', 'TESTNET', 'FUTURENET'].includes(net.toUpperCase())) {
          setWalletNetwork(net.toUpperCase() as StellarNetwork);
        }
      } catch {
        setWalletNetwork(null);
      }
    }
  }, []);

  const connect = useCallback(
    async (providerName: string) => {
      const provider = WALLET_PROVIDERS.find(
        (p) => p.name.toLowerCase() === providerName.toLowerCase() || p.id === providerName
      );
      if (!provider) throw new Error(`Unknown wallet: ${providerName}`);
      setIsConnecting(true);
      setError(null);
      sendTransaction({ type: 'CONNECT_WALLET', walletName: provider.name });
      try {
        const pk = await provider.connect();
        setPublicKey(pk);
        setActiveWallet(provider.name);
        await updateWalletNetwork(provider);
        localStorage.setItem(
          'stellar_wallet',
          JSON.stringify({ wallet: provider.name, pk, network: activeNetwork })
        );
        sendTransaction({ type: 'WALLET_CONNECTED', walletName: provider.name, publicKey: pk });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Connection failed';
        setError(msg);
        sendTransaction({ type: 'FAIL', error: msg });
        throw e;
      } finally {
        setIsConnecting(false);
      }
    },
    [activeNetwork, sendTransaction, updateWalletNetwork]
  );

  const authenticateWithWallet = useCallback(
    async (providerName: string) => {
      const provider = WALLET_PROVIDERS.find((p) => p.name === providerName);
      if (!provider) throw new Error(`Unknown wallet: ${providerName}`);

      setIsConnecting(true);
      setError(null);
      sendTransaction({ type: 'CONNECT_WALLET', walletName: providerName });

      try {
        const pk = await provider.connect();
        setPublicKey(pk);
        setActiveWallet(providerName);
        localStorage.setItem('stellar_wallet', JSON.stringify({ wallet: providerName, pk }));
        sendTransaction({ type: 'WALLET_CONNECTED', walletName: providerName, publicKey: pk });

        // 1. Request SEP-0010 Challenge Transaction from Backend
        const challengeRes = await authAPI.getSep10Challenge(pk);
        if (!challengeRes?.transaction) {
          throw new Error('Server failed to generate SEP-0010 challenge');
        }

        // 2. Sign Challenge Transaction with Wallet
        sendTransaction({ type: 'REQUEST_SIGNATURE', transactionXdr: challengeRes.transaction });
        const signedXdr = await provider.signTransaction(challengeRes.transaction);
        sendTransaction({ type: 'SIGNATURE_APPROVED', signedTransactionXdr: signedXdr });

        // 3. Submit Signed Challenge to Backend for Verification & Token Issuance
        const authResponse = await authAPI.verifySep10Challenge(signedXdr);

        if (authResponse?.token) {
          localStorage.setItem('token', authResponse.token);
          localStorage.setItem('user', JSON.stringify(authResponse.user));
        }

        return authResponse;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Wallet authentication failed';
        setError(msg);
        sendTransaction({ type: 'FAIL', error: msg });
        throw e;
      } finally {
        setIsConnecting(false);
      }
    },
    [sendTransaction]
  );

  const disconnect = useCallback(async () => {
    const provider = WALLET_PROVIDERS.find((p) => p.name === activeWallet);
    await provider?.disconnect();
    setPublicKey(null);
    setActiveWallet(null);
    setWalletNetwork(null);
    localStorage.removeItem('stellar_wallet');
    sendTransaction({ type: 'DISCONNECT_WALLET' });
  }, [activeWallet, sendTransaction]);

  const setAppNetwork = useCallback((network: StellarNetwork) => {
    setActiveNetwork(network);
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('stellar_wallet');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          localStorage.setItem(
            'stellar_wallet',
            JSON.stringify({ ...parsed, network })
          );
        } catch {}
      }
    }
  }, []);

  const switchNetwork = useCallback(
    async (targetNetwork: StellarNetwork) => {
      const provider = WALLET_PROVIDERS.find((p) => p.name === activeWallet);
      if (provider?.switchNetwork) {
        const success = await provider.switchNetwork(targetNetwork);
        if (success) {
          setWalletNetwork(targetNetwork);
        }
      }
      setAppNetwork(targetNetwork);
    },
    [activeWallet, setAppNetwork]
  );

  const isNetworkDivergent =
    walletNetwork !== null && walletNetwork !== activeNetwork;

  const signTransaction = useCallback(
    async (xdr: string, opts?: { networkPassphrase?: string }) => {
      if (isNetworkDivergent) {
        throw new Error(
          `Network mismatch: Application is set to ${activeNetwork} while wallet is connected to ${walletNetwork}. Please switch networks before signing.`
        );
      }
      const provider = WALLET_PROVIDERS.find((p) => p.name === activeWallet);
      if (!provider) throw new Error('No wallet connected');
      sendTransaction({ type: 'REQUEST_SIGNATURE', transactionXdr: xdr });
      try {
        const targetPassphrase = opts?.networkPassphrase || NETWORK_PASSPHRASES[activeNetwork];
        const signedXdr = await provider.signTransaction(xdr, {
          networkPassphrase: targetPassphrase,
        });
        sendTransaction({ type: 'SIGNATURE_APPROVED', signedTransactionXdr: signedXdr });
        return signedXdr;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Transaction signing failed';
        sendTransaction({ type: 'FAIL', error: msg });
        throw e;
      }
    },
    [activeNetwork, activeWallet, isNetworkDivergent, sendTransaction, walletNetwork]
  );

  return (
    <WalletContext.Provider
      value={{
        publicKey,
        activeWallet,
        isConnecting,
        isConnected: !!publicKey,
        connected: !!publicKey,
        error,
        activeNetwork,
        walletNetwork,
        isNetworkDivergent,
        blockHeight,
        balances,
        availableWallets: WALLET_PROVIDERS,
        detectedWallets,
        transactionState: transactionSnapshot.value as Web3TransactionStatus,
        transactionContext: transactionSnapshot.context,
        connect,
        authenticateWithWallet,
        disconnect,
        signTransaction,
        switchNetwork,
        setAppNetwork,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
