const { createApp, ref, computed, onUnmounted, watch, nextTick } = Vue;

/* ------------------------------------------------------------------ */
/*  helper: map a DB order row to view shape                          */
/* ------------------------------------------------------------------ */
const mapOrderRow = (r) => ({
  id: r.id,
  publisher_id: r.publisher_id,
  hospital: r.hospital,
  gender: r.gender_pref,
  tags: r.tags || [],
  price: Math.max(1, Math.round(Number(r.price_cents) / 100)),
  note: r.note,
  status: r.status,
  taker_id: r.taker_id,
});

/* ------------------------------------------------------------------ */
/*  toast notification system                                         */
/* ------------------------------------------------------------------ */
const toast = (() => {
  const message = ref('');
  const type = ref('info');   // info | success | error
  const visible = ref(false);
  let timer = null;

  const show = (msg, t = 'info', duration = 3500) => {
    clearTimeout(timer);
    message.value = msg;
    type.value = t;
    visible.value = true;
    timer = setTimeout(() => { visible.value = false; }, duration);
  };

  return { message, type, visible, show };
})();

/* ------------------------------------------------------------------ */
/*  app                                                               */
/* ------------------------------------------------------------------ */
createApp({
  setup() {
    /* ---- supabase & config ---- */
    const cfg = window.__SUPABASE_CONFIG__ || {};
    const configError = ref('');
    if (!cfg.url || !cfg.anonKey) {
      configError.value = '请编辑 js/supabase-config.js 填入 url 与 anonKey，或在 Netlify 设置 SUPABASE_URL、SUPABASE_ANON_KEY 后重新构建。';
    }

    const sb = cfg.url && cfg.anonKey ? supabase.createClient(cfg.url, cfg.anonKey) : null;

    /* ---- auth state ---- */
    const session = ref(null);
    const authReady = ref(false);
    const showAuthModal = ref(false);
    const authEmail = ref('');
    const authPassword = ref('');
    const authError = ref('');
    const authBusy = ref(false);

    /* ---- orders ---- */
    const availableOrders = ref([]);
    const ordersLoading = ref(false);
    let ordersChannel = null;

    /* ---- views ---- */
    const currentView = ref('hall');
    const showPublishModal = ref(false);
    const showSuccess = ref(false);

    const availableTags = ['情绪稳定', '细心稳重', '健谈活跃', '医科背景优先', '边界感强', '力量型'];
    const newForm = ref({ hospital: '北师大校医院', gender: '仅限女生', tags: [], note: '', price: 50 });
    const publishErrors = ref({});

    /* ---- chat / timer ---- */
    const activeOrder = ref(null);
    const chatMessages = ref([]);
    const timeLeft = ref(300);
    let timer = null;
    let lastVisibleTime = null;

    /* ---- computed ---- */
    const userEmail = computed(() => session.value?.user?.email || '');

    const formattedTime = computed(() => {
      const m = Math.floor(timeLeft.value / 60).toString().padStart(2, '0');
      const s = (timeLeft.value % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    });

    /* ---- profile ---- */
    const ensureProfile = async (user) => {
      if (!sb || !user) return;
      const { data } = await sb.from('profiles').select('id').eq('id', user.id).maybeSingle();
      if (!data) {
        const name = (user.user_metadata?.full_name || user.email?.split('@')[0] || '用户').slice(0, 32);
        await sb.from('profiles').insert({ id: user.id, display_name: name });
      }
    };

    /* ---- orders crud ---- */
    const fetchOpenOrders = async () => {
      if (!sb || !session.value) return;
      ordersLoading.value = true;
      const uid = session.value.user.id;
      const { data, error } = await sb
        .from('orders')
        .select('*')
        .eq('status', 'open')
        .order('created_at', { ascending: false });
      ordersLoading.value = false;
      if (error) {
        toast.show('加载订单失败: ' + error.message, 'error');
        return;
      }
      availableOrders.value = (data || [])
        .filter((o) => o.publisher_id !== uid)
        .map(mapOrderRow);
    };

    const subscribeOrders = () => {
      if (!sb || ordersChannel) return;
      ordersChannel = sb
        .channel('orders-hall')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders' },
          () => { fetchOpenOrders(); }
        )
        .subscribe();
    };

    const unsubscribeOrders = () => {
      if (ordersChannel && sb) {
        sb.removeChannel(ordersChannel);
        ordersChannel = null;
      }
    };

    watch(session, (s) => {
      if (s) {
        fetchOpenOrders();
        subscribeOrders();
      } else {
        unsubscribeOrders();
        availableOrders.value = [];
      }
    });

    /* ---- init ---- */
    (async () => {
      if (!sb) {
        authReady.value = true;
        return;
      }
      const { data: { session: s } } = await sb.auth.getSession();
      session.value = s;
      if (s?.user) await ensureProfile(s.user);
      authReady.value = true;
      sb.auth.onAuthStateChange(async (_event, s2) => {
        session.value = s2;
        if (s2?.user) await ensureProfile(s2.user);
      });
    })();

    /* ---- auth ---- */
    const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    const signIn = async () => {
      authError.value = '';
      if (!sb) return;
      if (!validateEmail(authEmail.value.trim())) {
        authError.value = '请输入有效的邮箱地址';
        return;
      }
      if (!authPassword.value) {
        authError.value = '请输入密码';
        return;
      }
      authBusy.value = true;
      const { error } = await sb.auth.signInWithPassword({
        email: authEmail.value.trim(),
        password: authPassword.value,
      });
      authBusy.value = false;
      if (error) authError.value = error.message;
      else {
        authEmail.value = '';
        authPassword.value = '';
        showAuthModal.value = false;
      }
    };

    const signUp = async () => {
      authError.value = '';
      if (!sb) return;
      if (!validateEmail(authEmail.value.trim())) {
        authError.value = '请输入有效的邮箱地址';
        return;
      }
      if (!authPassword.value) {
        authError.value = '请输入密码';
        return;
      }
      if (authPassword.value.length < 6) {
        authError.value = '密码至少需要 6 位';
        return;
      }
      authBusy.value = true;
      const { error } = await sb.auth.signUp({
        email: authEmail.value.trim(),
        password: authPassword.value,
      });
      authBusy.value = false;
      if (error) authError.value = error.message;
      else {
        authError.value = '注册成功！若项目已开启邮箱确认，请查收邮件后再登录。';
        authEmail.value = '';
        authPassword.value = '';
      }
    };

    const logout = async () => {
      if (sb) await sb.auth.signOut();
      session.value = null;
      currentView.value = 'hall';
    };

    /* ---- publish ---- */
    const toggleTag = (tag) => {
      const index = newForm.value.tags.indexOf(tag);
      if (index > -1) newForm.value.tags.splice(index, 1);
      else newForm.value.tags.push(tag);
    };

    const validatePublishForm = () => {
      const errors = {};
      if (!newForm.value.hospital) errors.hospital = '请选择医院';
      if (!newForm.value.gender) errors.gender = '请选择性别偏好';
      const price = Number(newForm.value.price);
      if (!price || price < 1) errors.price = '金额至少为 1 元';
      if (price > 9999) errors.price = '金额不能超过 9999 元';
      if (!newForm.value.note || !newForm.value.note.trim()) errors.note = '请填写病情简述';
      return errors;
    };

    const submitOrder = async () => {
      if (!sb || !session.value) return;
      publishErrors.value = validatePublishForm();
      if (Object.keys(publishErrors.value).length > 0) return;

      const priceCents = Math.round(Number(newForm.value.price) * 100);
      const { error } = await sb.from('orders').insert({
        publisher_id: session.value.user.id,
        hospital: newForm.value.hospital,
        gender_pref: newForm.value.gender,
        tags: newForm.value.tags,
        price_cents: priceCents,
        note: newForm.value.note.trim() || null,
      });
      if (error) {
        toast.show('发布失败: ' + error.message, 'error');
        return;
      }
      showPublishModal.value = false;
      newForm.value = { hospital: '北师大校医院', gender: '仅限女生', tags: [], note: '', price: 50 };
      publishErrors.value = {};
      toast.show('订单发布成功', 'success');
      await fetchOpenOrders();
    };

    /* ---- grab / chat ---- */
    const startTimer = () => {
      clearInterval(timer);
      lastVisibleTime = Date.now();
      timeLeft.value = 300;
      timer = setInterval(() => {
        timeLeft.value -= 1;
        if (timeLeft.value <= 0) {
          clearInterval(timer);
          toast.show('沟通超时，订单将释放回大厅', 'error');
          void releaseAndExit();
        }
      }, 1000);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        lastVisibleTime = Date.now();
      } else if (lastVisibleTime && activeOrder.value) {
        const elapsed = Math.floor((Date.now() - lastVisibleTime) / 1000);
        timeLeft.value = Math.max(0, timeLeft.value - elapsed);
      }
    };

    const grabOrder = async (order) => {
      if (!sb) return;
      const { data, error } = await sb.rpc('take_order', { p_order_id: order.id });
      if (error) {
        toast.show('抢单失败: ' + error.message, 'error');
        return;
      }
      activeOrder.value = mapOrderRow(data);
      currentView.value = 'chat';
      chatMessages.value = [
        { text: '你好，我已接单，我们可以沟通一下细节吗？', isMine: false },
      ];
      startTimer();
      document.addEventListener('visibilitychange', handleVisibilityChange);
    };

    const releaseAndExit = async () => {
      if (!sb || !activeOrder.value) return;
      await sb.rpc('release_order', { p_order_id: activeOrder.value.id }).catch(() => {});
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      currentView.value = 'hall';
      activeOrder.value = null;
      await fetchOpenOrders();
    };

    const sendQuickMsg = (text) => {
      chatMessages.value.push({ text, isMine: true });
      setTimeout(() => {
        chatMessages.value.push({ text: '收到，没问题！随时可以出发。', isMine: false });
      }, 800);
    };

    const confirmEscort = async () => {
      if (!sb || !activeOrder.value) return;
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      const { error } = await sb.rpc('confirm_order', { p_order_id: activeOrder.value.id });
      if (error) {
        toast.show('确认失败: ' + error.message, 'error');
        startTimer();
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return;
      }
      showSuccess.value = true;
      await fetchOpenOrders();
    };

    const cancelOrder = async () => {
      if (activeOrder.value?.status === 'taken') await releaseAndExit();
      else {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        currentView.value = 'hall';
        activeOrder.value = null;
      }
    };

    const resetApp = () => {
      showSuccess.value = false;
      currentView.value = 'hall';
      activeOrder.value = null;
    };

    /* ---- cleanup ---- */
    onUnmounted(() => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubscribeOrders();
    });

    /* ---- expose ---- */
    return {
      /* config */
      configError,
      /* auth */
      session, authReady, userEmail,
      showAuthModal, authEmail, authPassword, authError, authBusy,
      signIn, signUp, logout,
      /* orders */
      availableOrders, ordersLoading,
      /* views */
      currentView, showPublishModal, showSuccess,
      availableTags, newForm, publishErrors,
      toggleTag, submitOrder,
      /* chat */
      grabOrder, activeOrder, chatMessages, timeLeft, formattedTime,
      sendQuickMsg, confirmEscort, cancelOrder, resetApp,
      /* toast */
      toast,
    };
  },
}).mount('#app');
