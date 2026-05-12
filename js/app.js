const { createApp, ref, computed, onUnmounted, watch } = Vue;

/* ------------------------------------------------------------------ */
/*  localStorage helpers                                              */
/* ------------------------------------------------------------------ */
const LS_KEY = {
  userId: 'shiyouban_user_id',
  nickname: 'shiyouban_nickname',
};

const getOrCreateUserId = () => {
  let id = localStorage.getItem(LS_KEY.userId);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS_KEY.userId, id);
  }
  return id;
};

const getSavedNickname = () => localStorage.getItem(LS_KEY.nickname) || '';
const saveNickname = (name) => localStorage.setItem(LS_KEY.nickname, name);
const clearIdentity = () => {
  localStorage.removeItem(LS_KEY.userId);
  localStorage.removeItem(LS_KEY.nickname);
};

/* ------------------------------------------------------------------ */
/*  quiz                                                              */
/* ------------------------------------------------------------------ */
const QUIZ = {
  question: '北师大的天使是什么？',
  options: [
    { key: 'A', text: '乌鸦' },
    { key: 'B', text: '天鹅' },
    { key: 'C', text: '天使' },
    { key: 'D', text: '鲁迅' },
  ],
  answer: 'A',
};

/* ------------------------------------------------------------------ */
/*  map a DB order row to view shape                                  */
/* ------------------------------------------------------------------ */
const mapOrderRow = (r, currentUserId = '') => ({
  id: r.id,
  publisher_id: r.publisher_id,
  publisher_name: r.publisher_name || '校友',
  hospital: r.hospital,
  gender: r.gender_pref,
  tags: r.tags || [],
  price: Math.max(1, Math.round(Number(r.price_cents) / 100)),
  note: r.note,
  status: r.status,
  taker_id: r.taker_id,
  isMine: r.publisher_id === currentUserId,
  involvesMe: r.publisher_id === currentUserId || r.taker_id === currentUserId,
});

/* ------------------------------------------------------------------ */
/*  toast notification                                                */
/* ------------------------------------------------------------------ */
const toast = (() => {
  const message = ref('');
  const type = ref('info');
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
      configError.value = '请编辑 js/supabase-config.js 填入 url 与 anonKey。';
    }

    const sb = cfg.url && cfg.anonKey ? supabase.createClient(cfg.url, cfg.anonKey) : null;

    /* ---- user identity (localStorage) ---- */
    const currentUserId = ref(getOrCreateUserId());
    const currentNickname = ref(getSavedNickname());
    const isLoggedIn = computed(() => !!currentNickname.value);

    /* ---- quiz flow ---- */
    const showQuizModal = ref(false);
    const selectedAnswer = ref('');
    const quizError = ref('');
    const quizPassed = ref(false);

    /* ---- nickname flow ---- */
    const showNicknameModal = ref(false);
    const nicknameInput = ref('');
    const nicknameError = ref('');

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

    /* ---- chat ---- */
    const activeOrder = ref(null);
    const chatMessages = ref([]);
    const newMessageText = ref('');
    const timeLeft = ref(300);
    const chatInputRef = ref(null);
    let timer = null;
    let lastVisibleTime = null;
    let messagesChannel = null;

    const isTaker = computed(() =>
      activeOrder.value && activeOrder.value.taker_id === currentUserId.value
    );

    /* ---- computed ---- */
    const formattedTime = computed(() => {
      const m = Math.floor(timeLeft.value / 60).toString().padStart(2, '0');
      const s = (timeLeft.value % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    });

    /* ---- orders fetch ---- */
    const fetchHallOrders = async () => {
      if (!sb || !isLoggedIn.value) return;
      ordersLoading.value = true;
      const uid = currentUserId.value;

      // open orders (大厅)
      const { data: openData } = await sb
        .from('orders')
        .select('*')
        .eq('status', 'open')
        .order('created_at', { ascending: false });

      // my involved orders (taken / locked where i'm publisher or taker)
      const { data: myData } = await sb
        .from('orders')
        .select('*')
        .or(`publisher_id.eq.${uid},taker_id.eq.${uid}`)
        .not('status', 'eq', 'open')
        .not('status', 'eq', 'cancelled')
        .order('updated_at', { ascending: false });

      ordersLoading.value = false;

      const merged = [...(myData || []), ...(openData || [])];
      const seen = new Set();
      availableOrders.value = merged
        .filter(o => { const dup = seen.has(o.id); seen.add(o.id); return !dup; })
        .map(r => mapOrderRow(r, uid));
    };

    const subscribeOrders = () => {
      if (!sb || ordersChannel) return;
      ordersChannel = sb
        .channel('orders-hall')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders' },
          () => { fetchHallOrders(); }
        )
        .subscribe();
    };

    const unsubscribeOrders = () => {
      if (ordersChannel && sb) {
        sb.removeChannel(ordersChannel);
        ordersChannel = null;
      }
    };

    watch(isLoggedIn, (loggedIn) => {
      if (loggedIn) {
        fetchHallOrders();
        subscribeOrders();
      } else {
        unsubscribeOrders();
        unsubscribeMessages();
        availableOrders.value = [];
      }
    });

    // init
    (async () => {
      if (isLoggedIn.value) {
        await fetchHallOrders();
        subscribeOrders();
      }
    })();

    /* ---- quiz ---- */
    const checkAnswer = () => {
      quizError.value = '';
      if (!selectedAnswer.value) {
        quizError.value = '请选择一个选项';
        return;
      }
      if (selectedAnswer.value === QUIZ.answer) {
        quizPassed.value = true;
      } else {
        quizError.value = '答案不对哦，再想想北师大的校园特色吧～';
        selectedAnswer.value = '';
      }
    };

    const retryQuiz = () => {
      selectedAnswer.value = '';
      quizError.value = '';
      quizPassed.value = false;
    };

    /* ---- nickname ---- */
    const confirmNickname = async () => {
      const name = nicknameInput.value.trim();
      nicknameError.value = '';
      if (!name) {
        nicknameError.value = '请输入昵称';
        return;
      }
      if (name.length > 12) {
        nicknameError.value = '昵称最多 12 个字';
        return;
      }
      saveNickname(name);
      currentNickname.value = name;
      showNicknameModal.value = false;
      showQuizModal.value = false;
      toast.show('欢迎加入师友伴，' + name + '！', 'success');

      if (sb) {
        sb.from('profiles').upsert({
          id: currentUserId.value,
          display_name: name,
        }).then(() => {
          fetchHallOrders();
          subscribeOrders();
        });
      }
    };

    /* ---- logout ---- */
    const logout = () => {
      clearIdentity();
      currentNickname.value = '';
      currentView.value = 'hall';
      unsubscribeOrders();
      unsubscribeMessages();
      availableOrders.value = [];
      toast.show('已退出', 'info');
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
      const price = Number(newForm.value.price);
      if (!price || price < 1) errors.price = '金额至少为 1 元';
      if (price > 9999) errors.price = '金额不能超过 9999 元';
      if (!newForm.value.note || !newForm.value.note.trim()) errors.note = '请填写病情简述';
      return errors;
    };

    const submitOrder = async () => {
      if (!sb || !isLoggedIn.value) return;
      publishErrors.value = validatePublishForm();
      if (Object.keys(publishErrors.value).length > 0) return;

      const priceCents = Math.round(Number(newForm.value.price) * 100);
      const { error } = await sb.from('orders').insert({
        publisher_id: currentUserId.value,
        publisher_name: currentNickname.value,
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
      await fetchHallOrders();
    };

    /* ---- messages ---- */
    const loadMessages = async (orderId) => {
      if (!sb) return;
      const { data, error } = await sb
        .from('messages')
        .select('*')
        .eq('order_id', orderId)
        .order('created_at', { ascending: true });
      if (!error) {
        chatMessages.value = (data || []).map(m => ({
          ...m,
          isMine: m.sender_id === currentUserId.value,
        }));
      }
    };

    const sendMessage = async () => {
      const text = newMessageText.value.trim();
      if (!text || !sb || !activeOrder.value) return;
      const { error } = await sb.from('messages').insert({
        order_id: activeOrder.value.id,
        sender_id: currentUserId.value,
        sender_name: currentNickname.value,
        text,
      });
      if (error) {
        toast.show('发送失败: ' + error.message, 'error');
        return;
      }
      newMessageText.value = '';
    };

    const subscribeMessages = (orderId) => {
      if (!sb || messagesChannel) return;
      messagesChannel = sb
        .channel(`messages-${orderId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `order_id=eq.${orderId}` },
          (payload) => {
            chatMessages.value.push({
              ...payload.new,
              isMine: payload.new.sender_id === currentUserId.value,
            });
          }
        )
        .subscribe();
    };

    const unsubscribeMessages = () => {
      if (messagesChannel && sb) {
        sb.removeChannel(messagesChannel);
        messagesChannel = null;
      }
    };

    /* ---- timer ---- */
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

    /* ---- enter / leave chat ---- */
    const enterChat = (order, withCountdown = false) => {
      activeOrder.value = order;
      currentView.value = 'chat';
      chatMessages.value = [];
      newMessageText.value = '';
      loadMessages(order.id);
      subscribeMessages(order.id);
      if (withCountdown) {
        startTimer();
        document.addEventListener('visibilitychange', handleVisibilityChange);
      }
    };

    const leaveChat = () => {
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubscribeMessages();
      currentView.value = 'hall';
      activeOrder.value = null;
    };

    /* ---- grab ---- */
    const grabOrder = async (order) => {
      if (!sb) return;
      const { data, error } = await sb.rpc('take_order', {
        p_order_id: order.id,
        p_user_id: currentUserId.value,
      });
      if (error) {
        toast.show('抢单失败: ' + error.message, 'error');
        return;
      }
      const taken = mapOrderRow(data, currentUserId.value);
      await fetchHallOrders();
      enterChat(taken, true);
    };

    /* ---- release ---- */
    const releaseAndExit = async () => {
      if (!sb || !activeOrder.value) return;
      await sb.rpc('release_order', {
        p_order_id: activeOrder.value.id,
        p_user_id: currentUserId.value,
      }).catch(() => {});
      leaveChat();
      await fetchHallOrders();
    };

    /* ---- confirm ---- */
    const confirmEscort = async () => {
      if (!sb || !activeOrder.value) return;
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      const { error } = await sb.rpc('confirm_order', {
        p_order_id: activeOrder.value.id,
        p_user_id: currentUserId.value,
      });
      if (error) {
        toast.show('确认失败: ' + error.message, 'error');
        startTimer();
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return;
      }
      showSuccess.value = true;
      unsubscribeMessages();
      await fetchHallOrders();
    };

    const cancelOrder = () => {
      if (activeOrder.value?.status === 'taken' && isTaker.value) {
        releaseAndExit();
      } else {
        leaveChat();
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
      unsubscribeMessages();
    });

    /* ---- expose ---- */
    return {
      configError,
      /* identity */
      currentUserId, currentNickname, isLoggedIn,
      /* quiz */
      QUIZ, showQuizModal, selectedAnswer, quizError, quizPassed,
      checkAnswer, retryQuiz,
      /* nickname */
      showNicknameModal, nicknameInput, nicknameError, confirmNickname,
      /* logout */
      logout,
      /* orders */
      availableOrders, ordersLoading,
      /* views */
      currentView, showPublishModal, showSuccess,
      availableTags, newForm, publishErrors,
      toggleTag, submitOrder,
      /* chat */
      enterChat, grabOrder, activeOrder, chatMessages, newMessageText,
      sendMessage, timeLeft, formattedTime, isTaker,
      confirmEscort, cancelOrder, resetApp,
      /* toast */
      toast,
    };
  },
}).mount('#app');
