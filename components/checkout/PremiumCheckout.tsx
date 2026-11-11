'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, ArrowRight, BadgeCheck, Banknote, Building2, Check, CheckCircle2,
  ChevronRight, Clock, Copy, CreditCard, FileText, Gift, Home, Landmark, Loader2,
  MapPin, Navigation, PackageCheck, Pencil, Phone, Plus, Shield, ShieldCheck,
  ShoppingBag, Sparkles, Store, Trash2, Truck, Upload, UserRound, Wallet, X,
} from 'lucide-react';
import type {
  PaymentSettings,
  Product,
  Profile,
  RevenueSettings,
  SavedAddress,
  ShippingOption,
  ShippingQuoteResult,
  User,
  DeliveryPartner,
} from '@/lib/types';
import { computePlatformFee } from '@/lib/fees';
import { effectiveProductPrice } from '@/lib/productPricing';
import { recordSponsoredConversion } from '@/lib/ads/conversion';
import { bestCoords, rankPartnersByProximity } from '@/lib/geo';
import { makeCheckoutGroupId } from '@/lib/ids';
import { dbOperations } from '@/lib/store';
import { toast } from '@/lib/feedback';
import PaystackPayment from '@/components/PaystackPayment';
import { SmartImage } from '@/components/ui/SmartImage';

type CheckoutItem = { product: Product; quantity: number };

type DeliveryChoice = {
  id: string;
  label: string;
  short: string;
  description: string;
  method: 'GOODSALE_PARTNER' | 'THIRD_PARTY_COURIER' | 'PICKUP';
  service: 'ECONOMY' | 'STANDARD' | 'EXPRESS';
  icon: React.ReactNode;
};

const DELIVERY_CHOICES: DeliveryChoice[] = [
  {
    id: 'rider',
    label: 'GoodSale local rider',
    short: 'Local rider',
    description: 'A verified GoodSale rider brings it to your door with live delivery updates.',
    method: 'GOODSALE_PARTNER',
    service: 'STANDARD',
    icon: <Truck className="h-5 w-5" />,
  },
  {
    id: 'standard',
    label: 'Standard courier',
    short: 'Standard',
    description: 'Tracked courier delivery for city and interstate shipments.',
    method: 'THIRD_PARTY_COURIER',
    service: 'STANDARD',
    icon: <PackageCheck className="h-5 w-5" />,
  },
  {
    id: 'express',
    label: 'Express courier',
    short: 'Express',
    description: 'Priority courier handling where the route supports it.',
    method: 'THIRD_PARTY_COURIER',
    service: 'EXPRESS',
    icon: <Sparkles className="h-5 w-5" />,
  },
  {
    id: 'pickup',
    label: 'Store pickup',
    short: 'Pickup',
    description: 'Collect directly from the seller. Available only when every seller offers it.',
    method: 'PICKUP',
    service: 'STANDARD',
    icon: <Store className="h-5 w-5" />,
  },
];

const emptyForm = {
  label: 'Home',
  contactName: '',
  phone: '',
  state: '',
  city: '',
  area: '',
  street: '',
  landmark: '',
  instructions: '',
  lat: undefined as number | undefined,
  lng: undefined as number | undefined,
  isDefault: false,
};

type AddressForm = {
  label: string;
  contactName: string;
  phone: string;
  state: string;
  city: string;
  area: string;
  street: string;
  landmark: string;
  instructions: string;
  lat?: number;
  lng?: number;
  isDefault: boolean;
};

const money = (value: number) => `₦${Math.max(0, Math.round(value)).toLocaleString()}`;

const addressLine = (address: AddressForm) =>
  [
    address.street,
    address.area,
    address.city,
    address.state,
    address.landmark ? `near ${address.landmark}` : '',
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');

const paymentLabels: Record<string, { label: string; description: string; icon: React.ReactNode }> = {
  escrow: { label: 'GoodSale Escrow', description: 'Protected card payment', icon: <Shield className="h-4 w-4" /> },
  card: { label: 'Debit / credit card', description: 'Paystack secure checkout', icon: <CreditCard className="h-4 w-4" /> },
  bank: { label: 'Bank transfer', description: 'Upload your transfer receipt', icon: <Landmark className="h-4 w-4" /> },
  cod: { label: 'Cash on delivery', description: 'Pay when your item arrives', icon: <Banknote className="h-4 w-4" /> },
  invoice: { label: 'Business invoice', description: 'Net terms for business buyers', icon: <FileText className="h-4 w-4" /> },
  partial: { label: 'Partial deposit', description: 'Pay a deposit, settle later', icon: <Wallet className="h-4 w-4" /> },
};

function StepRail({ step, onBack }: { step: number; onBack: (step: number) => void }) {
  const steps = ['Address', 'Delivery', 'Summary', 'Payment'];
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {steps.map((label, index) => {
        const number = index + 1;
        const done = step > number;
        const active = step === number;
        return (
          <React.Fragment key={label}>
            <button
              type="button"
              disabled={number > step}
              onClick={() => onBack(number)}
              className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold transition-colors ${
                active
                  ? 'border-jade-600 bg-jade-600 text-white'
                  : done
                    ? 'border-jade-500/30 bg-jade-500/10 text-jade-700 dark:text-jade-300'
                    : 'border-ink-200 text-ink-400 dark:border-ink-800'
              } ${number < step ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <span className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${
                active ? 'bg-white/20' : done ? 'bg-jade-600 text-white' : 'bg-ink-100 dark:bg-ink-800'
              }`}>
                {done ? <Check className="h-2.5 w-2.5" /> : number}
              </span>
              {label}
            </button>
            {number < steps.length && <ChevronRight className="h-3 w-3 shrink-0 text-ink-300" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default function PremiumCheckout({
  items,
  user,
  profile,
  revenueSettings,
  paymentSettings,
  deliveryPartners,
  onBack,
  onOrders,
  onClearCart,
}: {
  items: CheckoutItem[];
  user: User;
  profile?: Profile;
  revenueSettings: RevenueSettings;
  paymentSettings?: PaymentSettings;
  deliveryPartners: DeliveryPartner[];
  onBack: () => void;
  onOrders: () => void;
  onClearCart: () => void;
}) {
  const [step, setStep] = useState(1);
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [form, setForm] = useState<AddressForm>({
    ...emptyForm,
    contactName: user.fullName,
    phone: user.phoneNumber,
    state: profile?.state || '',
    city: profile?.city || '',
    street: profile?.address || '',
    isDefault: true,
  });

  const [quotes, setQuotes] = useState<Record<string, { quote?: ShippingQuoteResult; error?: string; loading: boolean }>>({});
  const [selectedChoice, setSelectedChoice] = useState('rider');
  const [selectedPartnerId, setSelectedPartnerId] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState('escrow');
  const [invoiceTerms, setInvoiceTerms] = useState('Net 15');
  const [bankReceipt, setBankReceipt] = useState<string | null>(null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  const [protect, setProtect] = useState(false);
  const [usePoints, setUsePoints] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [payOrderIds, setPayOrderIds] = useState<number[]>([]);
  const [payAmount, setPayAmount] = useState(0);
  const [placedOrders, setPlacedOrders] = useState<{ id: number; orderNumber: string; productId?: number; trackingId?: string }[]>([]);
  const [success, setSuccess] = useState(false);
  const quoteControllers = useRef<AbortController[]>([]);
  const trackingLookups = useRef<Set<number>>(new Set());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const missing = placedOrders.filter(
      (order) => !order.trackingId && !trackingLookups.current.has(order.id)
    );
    if (!missing.length) return;
    missing.forEach((order) => trackingLookups.current.add(order.id));
    let cancelled = false;
    void Promise.all(
      missing.map(async (order) => {
        try {
          const res = await fetch(`/api/tracking/${encodeURIComponent(order.orderNumber)}`, { cache: 'no-store' });
          const payload = await res.json().catch(() => null);
          return { id: order.id, trackingId: payload?.success ? payload.data?.trackingId : undefined };
        } catch {
          return { id: order.id, trackingId: undefined };
        }
      })
    ).then((rows) => {
      if (cancelled) return;
      setPlacedOrders((current) =>
        current.map((order) => {
          const match = rows.find((row) => row.id === order.id && row.trackingId);
          return match ? { ...order, trackingId: match.trackingId } : order;
        })
      );
    });
    return () => {
      cancelled = true;
    };
  }, [placedOrders]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/checkout/addresses', { cache: 'no-store' });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) return;
        if (cancelled) return;
        const addresses = (payload.addresses || []) as SavedAddress[];
        setSaved(addresses);
        if (addresses.length > 0) {
          const preferred = addresses.find((address) => address.isDefault) || addresses[0];
          setSelectedAddressId(preferred.id);
          setForm({ ...preferred });
          setShowAddressForm(false);
        } else {
          setShowAddressForm(true);
        }
      } catch {
        if (!cancelled) setShowAddressForm(true);
      } finally {
        if (!cancelled) setLoadingAddresses(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const destination = useMemo(() => {
    const coords = form.lat != null && form.lng != null ? { lat: form.lat, lng: form.lng } : undefined;
    return {
      address: addressLine(form),
      city: form.city.trim(),
      state: form.state.trim(),
      landmark: form.landmark.trim(),
      lat: coords?.lat,
      lng: coords?.lng,
    };
  }, [form]);

  const quoteKey = useMemo(
    () => items.map((item) => `${item.product.id}:${item.quantity}`).join('|'),
    [items]
  );

  useEffect(() => {
    quoteControllers.current.forEach((controller) => controller.abort());
    quoteControllers.current = [];
    const quoteItems = itemsRef.current;
    if (!quoteItems.length || !destination.city || !destination.state || !destination.address) {
      setQuotes({});
      return;
    }

    const timer = setTimeout(() => {
      const next: Record<string, { quote?: ShippingQuoteResult; error?: string; loading: boolean }> = {};
      DELIVERY_CHOICES.forEach((choice) => {
        next[choice.id] = { loading: true };
      });
      setQuotes(next);

      DELIVERY_CHOICES.forEach((choice) => {
        const controller = new AbortController();
        quoteControllers.current.push(controller);
        void (async () => {
          try {
            const res = await fetch('/api/shipping/quote', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: JSON.stringify({
                items: quoteItems.map((item) => ({ productId: item.product.id, quantity: item.quantity })),
                destination: {
                  address: destination.address,
                  city: destination.city,
                  state: destination.state,
                  lat: destination.lat,
                  lng: destination.lng,
                },
                deliveryMethod: choice.method,
                serviceType: choice.service,
              }),
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.quote) {
              throw new Error(payload?.error || 'Unavailable for this destination.');
            }
            if (controller.signal.aborted) return;
            setQuotes((current) => ({
              ...current,
              [choice.id]: { quote: payload.quote as ShippingQuoteResult, loading: false },
            }));
          } catch (error) {
            if (controller.signal.aborted) return;
            setQuotes((current) => ({
              ...current,
              [choice.id]: {
                error: error instanceof Error ? error.message : 'Unavailable for this destination.',
                loading: false,
              },
            }));
          }
        })();
      });
    }, 350);

    return () => {
      clearTimeout(timer);
      quoteControllers.current.forEach((controller) => controller.abort());
    };
    // items are keyed by quoteKey; avoid re-pricing on unrelated parent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, destination.address, destination.city, destination.state, destination.lat, destination.lng]);

  const choice = DELIVERY_CHOICES.find((candidate) => candidate.id === selectedChoice) || DELIVERY_CHOICES[0];
  const selectedQuote = quotes[selectedChoice]?.quote;
  const selectedError = quotes[selectedChoice]?.error;
  const quoteLoading = quotes[selectedChoice]?.loading;

  const optionForGroup = useCallback(
    (group: ShippingQuoteResult['groups'][number]) =>
      group.options.find(
        (option) => option.method === choice.method && (choice.method !== 'THIRD_PARTY_COURIER' || option.service === choice.service)
      ) || group.options.find((option) => option.method === choice.method),
    [choice.method, choice.service]
  );

  const quoteReady = Boolean(
    selectedQuote?.quoteId &&
    selectedQuote.groups.length > 0 &&
    selectedQuote.groups.every((group) => Boolean(optionForGroup(group)))
  );

  const deliveryFee = useMemo(() => {
    if (!selectedQuote || !quoteReady) return 0;
    return selectedQuote.groups.reduce((sum, group) => sum + (optionForGroup(group)?.fee || 0), 0);
  }, [selectedQuote, quoteReady, optionForGroup]);

  const deliveryEta = useMemo(() => {
    if (!selectedQuote || !quoteReady) return null;
    const options = selectedQuote.groups.map(optionForGroup).filter(Boolean) as ShippingOption[];
    if (!options.length) return null;
    return {
      min: Math.min(...options.map((option) => option.etaMinDays)),
      max: Math.max(...options.map((option) => option.etaMaxDays)),
    };
  }, [selectedQuote, quoteReady, optionForGroup]);

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + effectiveProductPrice(item.product) * item.quantity, 0),
    [items]
  );
  const serviceFee = useMemo(
    () => items.reduce((sum, item) => sum + computePlatformFee(revenueSettings, effectiveProductPrice(item.product) * item.quantity).amount, 0),
    [items, revenueSettings]
  );
  const protectFee = protect ? revenueSettings?.goodSaleProtectFee || 1500 : 0;
  const pointsDiscount = usePoints ? Math.min(user.goodPoints, Math.floor(subtotal / 10)) * 10 : 0;
  const total = Math.max(0, subtotal + serviceFee + deliveryFee + protectFee - pointsDiscount);

  const sellerCount = useMemo(() => new Set(items.map((item) => item.product.sellerId)).size, [items]);

  const allowedMethods = useMemo(() => {
    const enabled = paymentSettings?.enabledMethods?.length
      ? paymentSettings.enabledMethods.map((method) => method.toLowerCase())
      : ['escrow', 'card', 'bank', 'cod', 'invoice', 'partial'];
    const perProduct = items.map((item) =>
      (item.product.paymentMethods?.length ? item.product.paymentMethods : enabled).map((method) => method.toLowerCase())
    );
    const intersection = perProduct.length
      ? perProduct.reduce((current, methods) => current.filter((method) => methods.includes(method)))
      : enabled;
    const final = intersection.filter((method) => enabled.includes(method));
    return final.length ? final : ['escrow'];
  }, [items, paymentSettings]);

  useEffect(() => {
    if (!allowedMethods.includes(paymentMethod)) setPaymentMethod(allowedMethods[0]);
  }, [allowedMethods, paymentMethod]);

  const preferredRiders = useMemo(() => {
    const origin = bestCoords(
      { lat: form.lat, lng: form.lng },
      null,
      form.city,
      form.state,
      addressLine(form)
    );
    return rankPartnersByProximity(
      origin,
      deliveryPartners.filter((partner) => partner.status === 'APPROVED' && partner.isAvailable),
      { maxKm: 50 }
    ).slice(0, 4);
  }, [deliveryPartners, form]);

  const addressValid = Boolean(
    form.contactName.trim() && form.phone.trim() && form.state.trim() && form.city.trim() && form.street.trim()
  );
  const canContinue = step === 1 ? addressValid : step === 2 ? quoteReady : true;

  const saveAddress = async () => {
    if (!addressValid) {
      toast.error('Add a contact name, phone, state, city and street before saving.');
      return;
    }
    setSavingAddress(true);
    try {
      const res = await fetch('/api/checkout/addresses', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, id: editingId || undefined }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) throw new Error(payload?.error || 'Could not save this address.');
      const address = payload.address as SavedAddress;
      setSaved((current) => {
        const next = current.filter((entry) => entry.id !== address.id);
        return [address, ...next.map((entry) => ({ ...entry, isDefault: address.isDefault ? false : entry.isDefault }))];
      });
      setSelectedAddressId(address.id);
      setShowAddressForm(false);
      setEditingId(null);
      toast.success('Delivery address saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save this address.');
    } finally {
      setSavingAddress(false);
    }
  };

  const deleteAddress = async (id: number) => {
    try {
      const res = await fetch(`/api/checkout/addresses?id=${id}`, { method: 'DELETE' });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) throw new Error(payload?.error || 'Could not delete address.');
      setSaved((current) => current.filter((address) => address.id !== id));
      if (selectedAddressId === id) {
        setSelectedAddressId(null);
        setShowAddressForm(true);
      }
      toast.success('Address removed.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete address.');
    }
  };

  const selectAddress = (address: SavedAddress) => {
    setSelectedAddressId(address.id);
    setForm({ ...address });
    setShowAddressForm(false);
    setEditingId(null);
  };

  const openNewAddress = () => {
    setEditingId(null);
    setSelectedAddressId(null);
    setForm({
      ...emptyForm,
      contactName: user.fullName,
      phone: user.phoneNumber,
      state: profile?.state || '',
      city: profile?.city || '',
      street: profile?.address || '',
      isDefault: saved.length === 0,
    });
    setShowAddressForm(true);
  };

  const createOrders = async (methodForPayment: string) => {
    if (!addressValid) {
      toast.error('Complete your delivery address first.');
      setStep(1);
      return;
    }
    if (!quoteReady) {
      toast.error('Choose a delivery method that is available for this destination.');
      setStep(2);
      return;
    }
    if (methodForPayment === 'bank' && !bankReceipt) {
      toast.error('Upload your bank transfer receipt before submitting.');
      return;
    }
    if (!termsAccepted) {
      toast.error('Accept the escrow and delivery terms to continue.');
      return;
    }

    setPlacing(true);
    const controllers = new AbortController();
    try {
      // Re-price immediately before creation; never trust the displayed fee.
      const res = await fetch('/api/shipping/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controllers.signal,
        body: JSON.stringify({
          items: items.map((item) => ({ productId: item.product.id, quantity: item.quantity })),
          destination: {
            address: destination.address,
            city: destination.city,
            state: destination.state,
            lat: destination.lat,
            lng: destination.lng,
          },
          deliveryMethod: choice.method,
          serviceType: choice.service,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success || !payload?.quote) {
        throw new Error(payload?.error || 'Delivery could not be priced. Please retry.');
      }
      const fresh = payload.quote as ShippingQuoteResult;
      if (!fresh.quoteId || fresh.requiresManualQuote) {
        throw new Error('This route needs a manual courier quotation before payment.');
      }

      const checkoutGroupId = makeCheckoutGroupId();
      const created: { id: number; orderNumber: string; productId: number }[] = [];
      let amount = 0;
      const chargedSellers = new Set<number>();

      for (const item of items) {
        const group = fresh.groups.find((candidate) => candidate.sellerId === item.product.sellerId);
        const option = group
          ? group.options.find(
              (candidate) =>
                candidate.method === choice.method &&
                (choice.method !== 'THIRD_PARTY_COURIER' || candidate.service === choice.service)
            ) || group.options.find((candidate) => candidate.method === choice.method)
          : undefined;
        if (!group || !option) {
          throw new Error(`Delivery is unavailable for ${item.product.title}.`);
        }

        const alreadyCharged = chargedSellers.has(item.product.sellerId);
        const fee = alreadyCharged ? 0 : option.fee;
        const breakdown = alreadyCharged
          ? { ...option.breakdown, total: 0, discount: option.fee, freeShipping: true }
          : { ...option.breakdown, total: fee };
        const order = await dbOperations.placeOrder(
          item.product.id,
          destination.address,
          destination.city,
          destination.state,
          methodForPayment,
          choice.method,
          usePoints,
          choice.method === 'GOODSALE_PARTNER' && selectedPartnerId ? selectedPartnerId : undefined,
          choice.service,
          protect && created.length === 0,
          bankReceipt || undefined,
          invoiceTerms,
          destination.lat != null && destination.lng != null
            ? { lat: destination.lat, lng: destination.lng }
            : undefined,
          item.quantity,
          {
            fee,
            breakdown,
            quoteId: fresh.quoteId,
            ruleId: option.breakdown.ruleId,
            zoneId: option.breakdown.zoneId,
            etaMin: option.etaMinDays,
            etaMax: option.etaMaxDays,
          },
          {
            phone: form.phone,
            instructions: form.instructions,
            checkoutGroupId,
          }
        );

        if (!order?.id) throw new Error(`Could not create the order for ${item.product.title}.`);
        chargedSellers.add(item.product.sellerId);
        created.push({ id: order.id, orderNumber: order.orderNumber, productId: item.product.id });
        amount += order.totalAmount;
      }

      if (!created.length) throw new Error('Could not create your order. Please retry.');
      const verified = await dbOperations.applyVerifiedShipping(fresh.quoteId, created.map((order) => order.id));
      if ('error' in verified) throw new Error(verified.error || 'Shipping could not be verified.');
      amount = verified.orders.reduce((sum, order) => sum + order.totalAmount, 0) || amount;
      // A partial checkout charges the deposit now; the balance is a later payment.
      if (methodForPayment === 'partial') {
        amount = Math.round(amount * ((items[0]?.product.partialPercent || 30) / 100));
      }

      const ordersWithIds = created.map((order) => ({
        ...order,
        id: verified.orders.find((entry) => entry.orderId === order.id)?.orderId || order.id,
      }));
      setPlacedOrders(ordersWithIds);

      if (['escrow', 'card', 'partial'].includes(methodForPayment)) {
        setPlacedOrders(ordersWithIds);
        setPayOrderIds(ordersWithIds.map((order) => order.id));
        setPayAmount(amount);
        setPaymentOpen(true);
        return;
      }

      void recordSponsoredConversion(ordersWithIds);
      setSuccess(true);
      onClearCart();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Checkout could not be completed.');
    } finally {
      setPlacing(false);
    }
  };

  const handlePaid = () => {
    setPaymentOpen(false);
    void recordSponsoredConversion(placedOrders);
    setSuccess(true);
    onClearCart();
  };

  if (success) {
    return (
      <div className="mx-auto max-w-2xl">
        <section className="overflow-hidden rounded-[2rem] border border-jade-500/20 bg-white shadow-xl shadow-jade-950/5 dark:bg-ink-900">
          <div className="relative bg-gradient-to-br from-jade-950 via-jade-900 to-jade-800 px-6 py-10 text-center text-white">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-white/20 bg-white/10">
              <CheckCircle2 className="h-8 w-8 text-gold-200" />
            </div>
            <p className="mt-5 text-[11px] font-bold uppercase tracking-[0.25em] text-gold-200">Order confirmed</p>
            <h2 className="mt-2 font-display text-2xl font-bold sm:text-3xl">Your GoodSale order is in motion</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-white/70">
              {placedOrders.length > 1
                ? `${placedOrders.length} seller shipments were created. Each has its own tracking ID.`
                : 'Your seller has been notified and a shipment tracking ID has been issued.'}
            </p>
          </div>
          <div className="space-y-3 p-5 sm:p-7">
            {placedOrders.map((order) => (
              <div key={order.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-ink-200 p-3 text-sm dark:border-ink-800">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">Order ID</p>
                  <p className="font-mono font-bold text-ink-900 dark:text-white">{order.orderNumber}</p>
                  {order.trackingId ? (
                    <Link href={`/track/${order.trackingId}`} className="mt-1 inline-flex font-mono text-[10px] font-bold text-jade-600 hover:underline dark:text-jade-300">
                      {order.trackingId} →
                    </Link>
                  ) : (
                    <p className="mt-1 text-[10px] text-ink-400">Issuing shipment tracking ID…</p>
                  )}
                </div>
                <span className="rounded-full bg-jade-500/10 px-2.5 py-1 text-[10px] font-bold text-jade-700 dark:text-jade-300">
                  Shipment created
                </span>
              </div>
            ))}
            <div className="rounded-2xl border border-gold-400/30 bg-gold-300/10 p-3 text-xs text-ink-600 dark:text-ink-300">
              <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-jade-600" />
              Your payment remains protected by escrow until delivery is confirmed.
            </div>
            <button
              type="button"
              onClick={onOrders}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl bg-jade-600 px-4 py-3.5 text-sm font-black text-white transition-colors hover:bg-jade-700"
            >
              Track my orders <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-jade-950 via-jade-900 to-jade-800 px-5 py-6 text-white sm:px-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              'radial-gradient(circle at 88% 8%, rgba(212,175,55,0.55), transparent 40%), radial-gradient(circle at 8% 90%, rgba(255,255,255,0.15), transparent 45%)',
          }}
        />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-[11px] font-semibold text-white/65 hover:text-white">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to cart
            </button>
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-2xl border border-white/20 bg-white/10">
                <ShoppingBag className="h-5 w-5" />
              </span>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-gold-200">GoodSale secure checkout</p>
                <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">One cart. Every shipment tracked.</h1>
              </div>
            </div>
            <p className="mt-3 max-w-xl text-xs text-white/65 sm:text-sm">
              {sellerCount > 1
                ? `${sellerCount} sellers · ${sellerCount} tracked shipments · one protected payment`
                : 'Escrow-protected payment, server-priced delivery and a real tracking ID for your shipment.'}
            </p>
          </div>
          <div className="min-w-[210px]">
            <StepRail step={step} onBack={(target) => target < step && setStep(target)} />
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.55fr_1fr]">
        <section className="min-w-0 rounded-[1.75rem] border border-ink-200 bg-white p-4 shadow-sm dark:border-ink-800 dark:bg-ink-900 sm:p-6">
          {step === 1 && (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-jade-600 dark:text-jade-400">Step 1 of 4</p>
                  <h2 className="mt-1 font-display text-xl font-bold text-ink-900 dark:text-white">Where should it go?</h2>
                  <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">Choose a saved address or add the exact drop-off details.</p>
                </div>
                <button
                  type="button"
                  onClick={openNewAddress}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-jade-200 px-3 py-1.5 text-[11px] font-bold text-jade-700 hover:bg-jade-500/10 dark:border-jade-500/30 dark:text-jade-300"
                >
                  <Plus className="h-3.5 w-3.5" /> New
                </button>
              </div>

              {loadingAddresses ? (
                <div className="flex items-center gap-2 rounded-2xl border border-ink-200 p-4 text-xs text-ink-400 dark:border-ink-800">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading saved addresses…
                </div>
              ) : saved.length > 0 ? (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {saved.map((address) => {
                    const active = selectedAddressId === address.id;
                    return (
                      <button
                        key={address.id}
                        type="button"
                        onClick={() => selectAddress(address)}
                        className={`relative rounded-2xl border p-3.5 text-left transition-all ${
                          active
                            ? 'border-jade-500 bg-jade-500/[0.06] ring-1 ring-jade-500'
                            : 'border-ink-200 hover:border-jade-300 dark:border-ink-800'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-jade-700 dark:text-jade-300">
                            {address.label === 'Home' ? <Home className="h-3 w-3" /> : <MapPin className="h-3 w-3" />}
                            {address.label}
                          </span>
                          {address.isDefault && (
                            <span className="rounded-full bg-gold-300/30 px-1.5 py-0.5 text-[9px] font-bold text-ink-600 dark:text-gold-200">Default</span>
                          )}
                        </div>
                        <p className="mt-2 line-clamp-2 text-xs font-semibold text-ink-800 dark:text-ink-100">{addressLine(address)}</p>
                        <p className="mt-1 text-[10px] text-ink-400">{address.contactName} · {address.phone}</p>
                        {address.landmark && <p className="mt-1 text-[10px] text-ink-400">Landmark: {address.landmark}</p>}
                        <div className="absolute right-2 top-10 flex gap-1">
                          <button
                            type="button"
                            aria-label="Edit address"
                            onClick={(event) => {
                              event.stopPropagation();
                              setEditingId(address.id);
                              setForm({ ...address });
                              setShowAddressForm(true);
                            }}
                            className="grid h-6 w-6 place-items-center rounded-full bg-white/80 text-ink-400 hover:text-jade-600 dark:bg-ink-900/80"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            aria-label="Delete address"
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteAddress(address.id);
                            }}
                            className="grid h-6 w-6 place-items-center rounded-full bg-white/80 text-ink-400 hover:text-red-500 dark:bg-ink-900/80"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {showAddressForm && (
                <div className="rounded-2xl border border-jade-500/20 bg-jade-500/[0.03] p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-xs font-bold text-ink-900 dark:text-white">{editingId ? 'Edit address' : 'New delivery address'}</h3>
                    {saved.length > 0 && (
                      <button type="button" onClick={() => { setShowAddressForm(false); setEditingId(null); }} className="text-ink-400 hover:text-ink-700 dark:hover:text-white">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold text-ink-400">Label</span>
                      <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Home, Office…" className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 dark:border-ink-700 dark:bg-ink-950 dark:text-white" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold text-ink-400">Contact name</span>
                      <input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 dark:border-ink-700 dark:bg-ink-950 dark:text-white" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold text-ink-400">Contact number</span>
                      <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" placeholder="+234…" className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 dark:border-ink-700 dark:bg-ink-950 dark:text-white" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold text-ink-400">State</span>
                      <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 dark:border-ink-700 dark:bg-ink-950 dark:text-white" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold text-ink-400">City</span>
                      <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 dark:border-ink-700 dark:bg-ink-950 dark:text-white" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold text-ink-400">Area / neighbourhood</span>
                      <input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 dark:border-ink-700 dark:bg-ink-950 dark:text-white" />
                    </label>
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-[10px] font-semibold text-ink-400">Street address</span>
                      <input value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 dark:border-ink-700 dark:bg-ink-950 dark:text-white" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold text-ink-400">Landmark</span>
                      <input value={form.landmark} onChange={(e) => setForm({ ...form, landmark: e.target.value })} placeholder="Nearest bus stop, mall…" className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 dark:border-ink-700 dark:bg-ink-950 dark:text-white" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold text-ink-400">Delivery instructions</span>
                      <input value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Gate code, drop-off note…" className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 dark:border-ink-700 dark:bg-ink-950 dark:text-white" />
                    </label>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-[11px] font-semibold text-ink-500 dark:text-ink-400">
                      <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} className="h-3.5 w-3.5 accent-jade-600" />
                      Make this my default address
                    </label>
                    <button
                      type="button"
                      onClick={() => void saveAddress()}
                      disabled={savingAddress || !addressValid}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-jade-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-jade-700 disabled:opacity-40"
                    >
                      {savingAddress ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Save address
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 rounded-2xl border border-ink-200 bg-ink-50 p-3 text-[10px] text-ink-500 dark:border-ink-800 dark:bg-ink-950/50 dark:text-ink-400">
                <ShieldCheck className="h-4 w-4 shrink-0 text-jade-600 dark:text-jade-400" />
                Your address is visible only to the seller, assigned rider or courier and GoodSale support.
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-jade-600 dark:text-jade-400">Step 2 of 4</p>
                <h2 className="mt-1 font-display text-xl font-bold text-ink-900 dark:text-white">Choose how it travels</h2>
                <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">Fees and delivery windows come from GoodSale&apos;s shipping rules for this destination.</p>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {DELIVERY_CHOICES.map((option) => {
                  const state = quotes[option.id];
                  const unavailable = Boolean(state?.error);
                  const selected = selectedChoice === option.id;
                  const priced = (state?.quote?.groups || [])
                    .map((group) =>
                      group.options.find(
                        (entry) =>
                          entry.method === option.method &&
                          (option.method !== 'THIRD_PARTY_COURIER' || entry.service === option.service)
                      ) || group.options.find((entry) => entry.method === option.method)
                    )
                    .filter(Boolean) as ShippingOption[];
                  const pricedTotal = priced.reduce((sum, entry) => sum + (entry.fee || 0), 0);
                  const pricedEta = priced.length
                    ? { min: Math.min(...priced.map((entry) => entry.etaMinDays)), max: Math.max(...priced.map((entry) => entry.etaMaxDays)) }
                    : null;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={unavailable}
                      onClick={() => setSelectedChoice(option.id)}
                      className={`relative rounded-2xl border p-4 text-left transition-all ${
                        selected
                          ? 'border-jade-500 bg-jade-500/[0.06] ring-1 ring-jade-500'
                          : 'border-ink-200 hover:border-jade-300 dark:border-ink-800 dark:hover:border-jade-500/30'
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className={`grid h-9 w-9 place-items-center rounded-xl ${selected ? 'bg-jade-600 text-white' : 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-300'}`}>
                          {option.icon}
                        </span>
                        {selected && <CheckCircle2 className="h-4 w-4 text-jade-600" />}
                      </div>
                      <p className="mt-2 text-xs font-bold text-ink-900 dark:text-white">{option.label}</p>
                      <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-ink-400">{option.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] font-bold">
                        <span className="rounded-full bg-ink-100 px-2 py-0.5 text-ink-700 dark:bg-ink-800 dark:text-ink-200">
                          {state?.loading ? 'Pricing…' : state?.error ? 'Unavailable' : state?.quote ? money(pricedTotal) : '—'}
                        </span>
                        {pricedEta && (
                          <span className="rounded-full bg-jade-500/10 px-2 py-0.5 text-jade-600 dark:text-jade-300">
                            {pricedEta.min}–{pricedEta.max} days
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {selectedError && (
                <p className="rounded-xl border border-amber-300/40 bg-amber-50 p-3 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/20 dark:text-amber-300">
                  {selectedError} Choose another option or contact support for a manual quote.
                </p>
              )}

              {choice.id === 'rider' && (
                <div className="rounded-2xl border border-ink-200 p-4 dark:border-ink-800">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-bold text-ink-900 dark:text-white">Preferred rider <span className="font-normal text-ink-400">(optional)</span></p>
                      <p className="mt-0.5 text-[10px] text-ink-400">GoodSale assigns the best available rider after payment if you skip this.</p>
                    </div>
                    {selectedPartnerId && (
                      <button type="button" onClick={() => setSelectedPartnerId(null)} className="text-[10px] font-bold text-jade-600 dark:text-jade-400">Auto-assign</button>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setSelectedPartnerId(null)}
                      className={`flex items-center gap-2 rounded-xl border p-2.5 text-left ${!selectedPartnerId ? 'border-jade-500 bg-jade-500/5' : 'border-ink-200 dark:border-ink-800'}`}
                    >
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-jade-500/10 text-jade-600"><Sparkles className="h-4 w-4" /></span>
                      <span className="text-[10px] font-bold text-ink-800 dark:text-ink-100">Auto-match best rider</span>
                    </button>
                    {preferredRiders.map(({ partner }) => (
                      <button
                        key={partner.id}
                        type="button"
                        onClick={() => setSelectedPartnerId(partner.id)}
                        className={`flex items-center gap-2 rounded-xl border p-2.5 text-left ${selectedPartnerId === partner.id ? 'border-jade-500 bg-jade-500/5' : 'border-ink-200 dark:border-ink-800'}`}
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-ink-100 text-[10px] font-bold text-ink-500 dark:bg-ink-800">
                          {partner.photoUrl ? <img src={partner.photoUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" /> : partner.fullName.slice(0, 1)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[10px] font-bold text-ink-800 dark:text-ink-100">{partner.fullName}</span>
                          <span className="block text-[9px] text-ink-400">{partner.vehicleType.replace('_', ' ')} · ★ {partner.rating}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-jade-600 dark:text-jade-400">Step 3 of 4</p>
                <h2 className="mt-1 font-display text-xl font-bold text-ink-900 dark:text-white">Review your order</h2>
                <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">Every line is priced by the server. Nothing is added at payment time.</p>
              </div>

              <div className="space-y-2.5">
                {items.map(({ product, quantity }) => (
                  <div key={product.id} className="flex gap-3 rounded-2xl border border-ink-200 p-3 dark:border-ink-800">
                    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-ink-100 dark:bg-ink-800">
                      <SmartImage src={product.images?.[0]} alt={product.title} seed={`checkout-${product.id}`} className="h-full w-full" imgClassName="object-cover" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-ink-900 dark:text-white">{product.title}</p>
                      <p className="mt-0.5 text-[10px] text-ink-400">Qty {quantity} · {product.sellerId === items[0]?.product.sellerId ? 'Shipment 1' : 'Separate seller shipment'}</p>
                      <p className="mt-1 text-xs font-bold text-jade-700 dark:text-jade-300">{money(effectiveProductPrice(product) * quantity)}</p>
                    </div>
                    {sellerCount > 1 && (
                      <span className="self-start rounded-full bg-gold-300/20 px-2 py-0.5 text-[9px] font-bold text-ink-500 dark:text-gold-200">Multi-shipment</span>
                    )}
                  </div>
                ))}
              </div>

              <div className="rounded-2xl border border-ink-200 p-3.5 text-xs dark:border-ink-800">
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-jade-600" />
                  <div>
                    <p className="font-semibold text-ink-800 dark:text-ink-100">{destination.address}</p>
                    <p className="mt-0.5 text-[10px] text-ink-400">{form.contactName} · {form.phone}</p>
                    {form.instructions && <p className="mt-1 text-[10px] text-ink-400">Note: {form.instructions}</p>}
                  </div>
                  <button type="button" onClick={() => setStep(1)} className="ml-auto shrink-0 text-[10px] font-bold text-jade-600 dark:text-jade-400">Edit</button>
                </div>
              </div>

              <div className="rounded-2xl border border-ink-200 p-3.5 text-xs dark:border-ink-800">
                <div className="flex items-center gap-2">
                  <Truck className="h-4 w-4 text-jade-600" />
                  <span className="font-semibold text-ink-800 dark:text-ink-100">{choice.label}</span>
                  <span className="ml-auto font-bold text-ink-900 dark:text-white">{money(deliveryFee)}</span>
                </div>
                {deliveryEta && <p className="ml-6 mt-1 text-[10px] text-ink-400">Estimated {deliveryEta.min}–{deliveryEta.max} days · {sellerCount} shipment{sellerCount === 1 ? '' : 's'}</p>}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setProtect((value) => !value)}
                  className={`rounded-2xl border p-3 text-left transition-all ${protect ? 'border-jade-500 bg-jade-500/5' : 'border-ink-200 dark:border-ink-800'}`}
                >
                  <span className="flex items-center gap-1.5 text-[10px] font-bold text-ink-800 dark:text-ink-100"><ShieldCheck className="h-3.5 w-3.5 text-jade-600" /> GoodSale Protect™</span>
                  <span className="mt-1 block text-[10px] text-ink-400">Extra coverage and priority support for {money(protectFee || revenueSettings?.goodSaleProtectFee || 1500)}.</span>
                </button>
                <button
                  type="button"
                  disabled={user.goodPoints <= 50}
                  onClick={() => setUsePoints((value) => !value)}
                  className={`rounded-2xl border p-3 text-left transition-all ${usePoints ? 'border-jade-500 bg-jade-500/5' : 'border-ink-200 dark:border-ink-800'} disabled:opacity-50`}
                >
                  <span className="flex items-center gap-1.5 text-[10px] font-bold text-ink-800 dark:text-ink-100"><Gift className="h-3.5 w-3.5 text-jade-600" /> Use GoodPoints</span>
                  <span className="mt-1 block text-[10px] text-ink-400">{user.goodPoints.toLocaleString()} points available · 1 point = ₦10 off.</span>
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-5">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-jade-600 dark:text-jade-400">Step 4 of 4</p>
                <h2 className="mt-1 font-display text-xl font-bold text-ink-900 dark:text-white">Pay securely</h2>
                <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">Only payment channels enabled for every item in this cart are shown.</p>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {allowedMethods.map((method) => {
                  const meta = paymentLabels[method] || paymentLabels.escrow;
                  const selected = paymentMethod === method;
                  return (
                    <button
                      key={method}
                      type="button"
                      onClick={() => setPaymentMethod(method)}
                      className={`rounded-2xl border p-3 text-left transition-all ${selected ? 'border-jade-500 bg-jade-500/5 ring-1 ring-jade-500' : 'border-ink-200 dark:border-ink-800'}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className={selected ? 'text-jade-600 dark:text-jade-400' : 'text-ink-400'}>{meta.icon}</span>
                        {selected && <CheckCircle2 className="h-3.5 w-3.5 text-jade-600" />}
                      </div>
                      <span className="mt-2 block text-[10px] font-bold text-ink-800 dark:text-ink-100">{meta.label}</span>
                      <span className="mt-0.5 block text-[9px] leading-tight text-ink-400">{meta.description}</span>
                    </button>
                  );
                })}
              </div>

              {paymentMethod === 'bank' && (
                <div className="rounded-2xl border border-jade-500/20 bg-jade-500/[0.03] p-3.5 text-xs">
                  <p className="font-bold text-ink-800 dark:text-ink-100">Transfer {money(total)} to the GoodSale escrow account</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 rounded-xl border border-jade-500/10 bg-white p-2.5 text-[10px] dark:bg-ink-950">
                    <span><span className="block text-ink-400">Bank</span><strong className="text-ink-800 dark:text-ink-100">Wema Bank (Alat Escrow)</strong></span>
                    <span><span className="block text-ink-400">Account</span><strong className="font-mono text-ink-800 dark:text-ink-100">1023847586</strong></span>
                    <span className="col-span-2 border-t border-ink-100 pt-1 dark:border-ink-800"><span className="block text-ink-400">Account name</span><strong className="text-ink-800 dark:text-ink-100">GoodSale Nigeria Marketplace Ltd</strong></span>
                  </div>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-jade-400/40 px-3 py-2 text-[10px] font-bold text-jade-700 dark:text-jade-300">
                    {uploadingReceipt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    {bankReceipt ? 'Receipt attached — replace' : 'Upload transfer receipt (PNG/JPG)'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (!file) return;
                        setUploadingReceipt(true);
                        try {
                          const { uploadMedia } = await import('@/lib/upload');
                          const url = await uploadMedia(file, 'product-images');
                          setBankReceipt(url);
                          toast.success('Transfer receipt attached.');
                        } catch {
                          toast.error('Receipt upload failed. Use a PNG or JPG under 5MB.');
                        } finally {
                          setUploadingReceipt(false);
                        }
                      }}
                    />
                  </label>
                </div>
              )}

              {paymentMethod === 'invoice' && (
                <div className="rounded-2xl border border-jade-500/20 bg-jade-500/[0.03] p-3.5 text-xs">
                  <p className="font-bold text-ink-800 dark:text-ink-100">Business invoice terms</p>
                  <select value={invoiceTerms} onChange={(event) => setInvoiceTerms(event.target.value)} className="mt-2 w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-xs dark:border-ink-700 dark:bg-ink-950 dark:text-white">
                    <option value="Net 15">Net 15</option>
                    <option value="Net 30">Net 30</option>
                    <option value="Net 60">Net 60 (approved partners)</option>
                  </select>
                  <p className="mt-2 text-[10px] text-ink-400">Total invoiced: <strong>{money(total)}</strong>. Payment is due within the selected terms.</p>
                </div>
              )}

              {paymentMethod === 'partial' && (
                <div className="rounded-2xl border border-ink-500/20 bg-ink-500/[0.03] p-3.5 text-xs">
                  <p className="font-bold text-ink-800 dark:text-ink-100">Deposit due today: {money(Math.round(total * ((items[0]?.product.partialPercent || 30) / 100)))}</p>
                  <p className="mt-1 text-[10px] text-ink-400">Remaining balance is due within {items[0]?.product.partialRemainingDays || 7} days after verified delivery.</p>
                </div>
              )}

              <label className="flex items-start gap-2 text-[10px] leading-relaxed text-ink-500 dark:text-ink-400">
                <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-jade-600" />
                I agree to GoodSale&apos;s escrow, delivery and dispute terms. My payment is held until delivery is confirmed.
              </label>

              <button
                type="button"
                disabled={placing || !quoteReady || !addressValid || (paymentMethod === 'bank' && !bankReceipt)}
                onClick={() => void createOrders(paymentMethod)}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-gold-300 to-gold-400 px-4 py-3.5 text-sm font-black text-ink-900 shadow-lg shadow-gold-400/25 transition-all hover:from-gold-200 hover:to-gold-300 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {placing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                {placing ? 'Creating your order…'
                  : paymentMethod === 'bank' ? 'Submit transfer for review'
                    : paymentMethod === 'invoice' ? 'Create invoice order'
                      : paymentMethod === 'cod' ? 'Confirm cash on delivery'
                        : paymentMethod === 'partial' ? `Pay ${money(Math.round(total * ((items[0]?.product.partialPercent || 30) / 100)))} deposit`
                          : `Pay ${money(total)} securely`}
              </button>
            </div>
          )}

          {step < 4 && (
            <div className="mt-5 flex items-center justify-between gap-3 border-t border-ink-100 pt-4 dark:border-ink-800">
              <button
                type="button"
                onClick={() => setStep((value) => Math.max(1, value - 1))}
                disabled={step === 1}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-ink-500 hover:text-ink-900 disabled:invisible dark:text-ink-400 dark:hover:text-white"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!canContinue) {
                    toast.error(step === 1 ? 'Complete the delivery address first.' : 'Choose an available delivery option.');
                    return;
                  }
                  setStep((value) => Math.min(4, value + 1));
                }}
                disabled={!canContinue}
                className="inline-flex items-center gap-2 rounded-xl bg-jade-600 px-5 py-2.5 text-xs font-bold text-white hover:bg-jade-700 disabled:opacity-40"
              >
                {step === 3 ? 'Continue to payment' : 'Continue'} <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </section>

        <aside className="space-y-3 lg:sticky lg:top-24">
          <div className="gs-receipt rounded-[1.5rem] border border-ink-200 bg-white p-5 shadow-[0_22px_52px_-42px_rgba(18,34,25,0.48)] dark:border-ink-800 dark:bg-ink-900">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-bold text-ink-900 dark:text-white">Order summary</h3>
              <span className="rounded-full bg-jade-500/10 px-2 py-0.5 text-[9px] font-bold text-jade-700 dark:text-jade-300">{sellerCount} shipment{sellerCount === 1 ? '' : 's'}</span>
            </div>
            <div className="mt-4 space-y-2.5 text-xs">
              <div className="flex justify-between"><span className="text-ink-400">Product subtotal</span><span className="font-semibold text-ink-800 dark:text-ink-100">{money(subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-ink-400">Delivery fee</span><span className="font-semibold text-ink-800 dark:text-ink-100">{quoteLoading ? 'Pricing…' : selectedError ? 'Unavailable' : money(deliveryFee)}</span></div>
              <div className="flex justify-between"><span className="text-ink-400">Service fee</span><span className="font-semibold text-ink-800 dark:text-ink-100">{money(serviceFee)}</span></div>
              {protectFee > 0 && <div className="flex justify-between text-jade-700 dark:text-jade-300"><span>GoodSale Protect™</span><span className="font-semibold">{money(protectFee)}</span></div>}
              {pointsDiscount > 0 && <div className="flex justify-between text-jade-700 dark:text-jade-300"><span>GoodPoints discount</span><span className="font-semibold">−{money(pointsDiscount)}</span></div>}
              <div className="flex items-baseline justify-between border-t border-ink-100 pt-3 dark:border-ink-800">
                <span className="text-sm font-bold text-ink-900 dark:text-white">Total</span>
                <span className="font-display text-xl font-black text-jade-700 dark:text-jade-300">{money(total)}</span>
              </div>
            </div>
            <div className="mt-4 space-y-2 border-t border-ink-100 pt-3 text-[10px] text-ink-500 dark:border-ink-800 dark:text-ink-400">
              <p className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-jade-600" /> Escrow protected · funds release after delivery</p>
              <p className="flex items-center gap-1.5"><BadgeCheck className="h-3.5 w-3.5 text-jade-600" /> Server-verified delivery fee</p>
              <p className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-jade-600" /> {destination.city || 'Choose an address'}{destination.state ? `, ${destination.state}` : ''}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-gold-400/20 bg-gold-300/[0.06] p-4 text-[10px] leading-relaxed text-ink-500 dark:text-ink-400">
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-ink-800 dark:text-ink-100"><Sparkles className="h-3.5 w-3.5 text-gold-500" /> Need a hand?</p>
            <p className="mt-1">If a route is not automatically priced, GoodSale can arrange a manual courier quote before you pay.</p>
            <button type="button" onClick={onBack} className="mt-2 font-bold text-jade-700 hover:underline dark:text-jade-300">Return to cart</button>
          </div>
        </aside>
      </div>

      {paymentOpen && payOrderIds[0] && (
        <div className="fixed inset-0 z-[120] grid place-items-center bg-ink-950/60 p-4 backdrop-blur-sm">
          <PaystackPayment
            email={user.email}
            amount={payAmount}
            orderId={payOrderIds[0]}
            orderIds={payOrderIds}
            onSuccess={handlePaid}
            onCancel={() => {
              setPaymentOpen(false);
              toast.info('Payment window closed. Your order is saved — pay from My Orders.');
              onClearCart();
              onOrders();
            }}
          />
        </div>
      )}
    </div>
  );
}
