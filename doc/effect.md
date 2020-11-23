# effect 源码分析
## 前言

- 终于到了心心念已久的 effect 篇了，真可谓千呼万唤始出来，费了老大的劲。 此篇章主要分析三个部分 createReactiveEffect 如何创建侦听函数;
  track 如何收集侦听函数(依赖收集)； 以及 trigger 如何触发侦听函数执行依赖更新。这三部分是该篇的核心内容组成，只要弄清楚了，也就知道 effect 是怎么回事了。
* [effect 篇源代码传送门](https://github.com/HUYIJUNCODING/vue-next-analysis/blob/master/packages/reactivity/src/effect.ts)

## 创建侦听函数

首先从创建 `effect` 开始，不过我们需要结合两个外部调用函数作为入口点，这两个函数就是很脸熟的 `watchEffect`，`watch`。如果要问我为啥从它们开刀,而不是直接从 `effect` 函数开始，我想给你个眼神自己体会，哈哈哈（反正我挺笨的，直接看 `effect` 还是有很多点想不明白，需要前置引导哈）。哦对了，差点给忘记了，这两个方法在 `packages/vue/dist/vue.global.js` 中找，如果发现自己项目没有这个目录文件，那就 `npm run dev` 运行下项目。

先找到这哥俩的位置

### watchEffect/watch

```js
// Simple effect.
function watchEffect(effect, options) {
  return doWatch(effect, null, options)
}
// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}
// implementation
function watch(source, cb, options) {
  if (!isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source, cb, options)
}
```

我们对以上代码稍作分析下：

- 两个函数内部都调用了 `doWatch` 函数，并返回该函数的执行结果，如果看过官方文档，此时我们就可以猜到 `doWatch` 函数会返回一个停止侦听的函数。
- `watchEffect` 没有 `cb` 回调，所以第一个参数即是原始函数，也是副作用函数，`watch` 的 `cb` 回调是副作用函数
- `watch` 的 `cb` 参数如果不是一个函数类型，会报警告，但是并不会报错，说明 `cb` 还可以是其他类型，但是一般写成函数比较好。

然后我们去 `doWatch` 里面看看，貌似很长的样子（不要乱想哦），就分段看吧。

### doWatch

```js
function doWatch(source, cb, { immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ, instance = currentInstance) {
if (!cb) {
  if (immediate !== undefined) {
    warn(
      `watch() "immediate" option is only respected when using the ` +
        `watch(source, callback, options?) signature.`
    )
  }
  if (deep !== undefined) {
    warn(
      `watch() "deep" option is only respected when using the ` +
        `watch(source, callback, options?) signature.`
    )
  }
}
const warnInvalidSource = s => {
  warn(
    `Invalid watch source: `,
    s,
    `A watch source can only be a getter/effect function, a ref, ` +
      `a reactive object, or an array of these types.`
  )
}
...
}
```

首先会对 `cb`（副作用函数） 是否存在进行判断，如果 `cb` 不存在，说明是 `watchEffect`，则进一步会对配置项 `immediate` 和 `deep` 属性存在进行判断，如果存在会报警告，从这里可以判断出，这两个属性按规定在 `watchEffect` 方法中是不建议配置使用的（不支持使用）。

```js
function doWatch(source, cb, { immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ, instance = currentInstance) {
  ...
      let getter;//传递给 `effect` 方法作为第一个参数（数据源函数fn）
      let forceTrigger = false;//是 `watch` 方法中数据源为 Ref 类型时是否强制执行 `cb` 副作用函数的开关
      //对数据源 `source` 数据类型进行判断
      //如果数据源是一个 Ref，则 getter是一个返回值为解了套的ref的函数
      if (isRef(source)) {
          getter = () => source.value;
          forceTrigger = !!source._shallow;//是否强制执行副作用函数的开关
      }
      //如果数据源是一个响应式的对象，则getter是一个返回该响应式对象的函数
      else if (isReactive(source)) {
          getter = () => source;
          deep = true;//深度侦听开关
      }
      //如果数据源是一个数组，则getter是一个遍历数组每一项元素然后分别对每一项元素进行类型判断后将其执行结果作为新数组元素返回这个新数组的函数。
      //watch的侦听多个数据源模式的数据源就在这里执行，返回的新数组会传递给 cb（副作用函数）作为第一个参数
      else if (isArray(source)) {
          getter = () => source.map(s => {
              if (isRef(s)) {
                  return s.value;
              }
              else if (isReactive(s)) {
                  return traverse(s);
              }
              else if (isFunction(s)) {
                  return callWithErrorHandling(s, instance, 2 /* WATCH_GETTER */);
              }
              else {
                   warnInvalidSource(s);
              }
          });
      }
    //如果数据源是一个函数，会分 cb是否存在两种情况初始化getter,如果cb存在，是 执行watch 函数，getter就是一个返回最新依赖数据的函数
    //如果不存在说明是执行watchEffect进来的，此时的getter既是数据源函数，同时也是副作用函数
      else if (isFunction(source)) {
          if (cb) {
              // getter with cb
              getter = () => callWithErrorHandling(source, instance, 2 /* WATCH_GETTER */);
          }
          else {
              // no cb -> simple effect
              getter = () => {
                  if (instance && instance.isUnmounted) {
                      return;
                  }
                  if (cleanup) {
                      cleanup();
                  }
                  return callWithErrorHandling(source, instance, 3 /* WATCH_CALLBACK */, [onInvalidate]);
              };
          }
      }
      //如果以上数据类型判断都不符合，那说明传入的数据源是一个无效的值，调用 warnInvalidSource 函数警告
      else {
          getter = NOOP;//为了不报错，会给getter一个默认函数
           warnInvalidSource(source);
      }
      //如果 cb副作用函数存在，并且 deep 为真，说明是 执行 watch 函数并且此时的数据源为一个响应式对象类型，则对
      //数据源的内部属性进行深度侦听（会将对象类型的属性收集进一个set集合里面），gette函数是一个执行了属性深度侦听和收集并返回这个响应式对象的函数
       if (cb && deep) {
          const baseGetter = getter;
          getter = () => traverse(baseGetter());
      }
}
...
}
```

首先定义了两个变量 `getter`，`forceTrigger` 。 `getter` 会传递给 `effect` 方法作为第一个参数（数据源函数 `fn`）,`forceTrigger` 是 `watch` 方法中数据源为 `Ref` 类型时是否强制执行 `cb` 副作用函数的开关。然后下来对数据源 `source` 数据类型进行判断：

- 如果数据源是 `Ref` 类型，则 `getter` 是一个返回值为解套的 `ref` 的函数
- 如果数据源是一个响应式的对象，则 `getter` 是一个返回该响应式对象的函数
- 如果数据源是一个数组，则 `getter`是一个遍历数组每一项元素然后分别对每一项元素进行类型判断后将其执行结果作为新数组元素然后返回这个新数组的函数（ `watch` 的侦听多个数据源模式的数据源就在这里执行，返回的新数组会传递给 `cb`（副作用函数）作为第一个参数）
- 如果数据源是一个函数，会分 `cb` 是否存在两种情况初始化 `getter`，如果 `cb` 存在，是执行 `watch` 函数进来的，`getter` 就是一个返回最新依赖数据的函数；如果不存在说明是执行 `watchEffect` 进来的，此时的 `getter` 既是数据源函数，同时也是副作用函数。

如果以上数据类型判断都不符合，那说明传入的数据源是一个无效的值，调用 `warnInvalidSource` 函数警告。接下来还有个判断，如果 `cb` 副作用函数存在，并且 `deep` 为真，说明是执行 `watch` 函数并且此时的数据源为一个响应式对象类型，则对数据源的内部属性进行深度侦听（会将对象类型的属性收集进一个 `set` 集合里面），`getter` 函数是一个执行了属性深度侦听和收集并返回这个响应式对象的函数。

```js
function doWatch(
  source,cb,{ immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ,instance = currentInstance
) {
  ...
  let cleanup //清理上次副作用函数执行时留下的还在生效的副作用,
  //用来注册一个清理上次副作用函数执行时留下的副作用结果的失效回调函数,这个失效函数
  //被执行的时机为每次副作用函数重新执行或者当前组件卸载时,fn参数是用户自定义的清除函数
  const onInvalidate = fn => {
    //onStop每次都会被重新挂载到effect侦听函数的options配置对象上,在副作用函数下一次执行时被调用
    cleanup = runner.options.onStop = () => {
      callWithErrorHandling(fn, instance, 4 /* WATCH_CLEANUP */)
    }
  }
  //初始化旧值
  let oldValue = isArray(source) ? [] : INITIAL_WATCHER_VALUE
  //job 函数是一个执行副作用的任务函数
  const job = () => {
    //runner就是侦听函数,如果active属性为false说明已经停止侦听,就直接返回,不去执行副作用
    if (!runner.active) {
      return
    }
    //cb是 watch 方法中的 副作用函数,如果存在就去执行它(副作用),如果不存在,说明是 watchEffect,则去执行runner函数,也就是effect自身
    if (cb) {
      // watch(source, cb)
      const newValue = runner()
      if (deep || forceTrigger || hasChanged(newValue, oldValue)) {
        // cleanup before running cb again
        if (cleanup) {
          cleanup()
        }
        callWithAsyncErrorHandling(cb, instance, 3 /* WATCH_CALLBACK */, [
          newValue,
          // pass undefined as the old value when it's changed for the first time
          oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
          onInvalidate
        ])
        oldValue = newValue
      }
    } else {
      // watchEffect
      runner()
    }
  }
  // important: mark the job as a watcher callback so that scheduler knows
  // it is allowed to self-trigger (#1727)
  job.allowRecurse = !!cb
}
...
```

可以看到 `cleanup` 在 `onInvalidate` 函数中被赋值,是 `onStop` 清理函数的引用。会在副作用函数每下一次执行时被调用，用来清除上次副作用函数执行时留下的还在生效的副作用,`onInvalidate` 是用来注册一个清理上次副作用函数执行时留下的副作用的失效回调函数,这个失效函数被执行的时机为每次副作用函数重新执行或者当前组件卸载时，`fn` 参数是用户自定义的清除函数。下来声明一个变量 `oldValue` 用来保存旧值，`job` 函数是一个执行副作用的任务函数，其内部会通过判断 `cb`副作用函数是否存在来区分是 `watchEffect` 和 `watch` 从而执行各自的副作用。

```js
function doWatch(
  source,cb,{ immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ,instance = currentInstance
) {
  ...
  let scheduler
if (flush === 'sync') {
  //直接等于job，会在组件更新时执行，可以与 pre对比，没有对于实例以及实例目前的状态判断，因此会组件更新时同步执行副作用
  scheduler = job
} else if (flush === 'post') {
  //组件更新后执行，会发现job每次都会被先推入一个队列而不是去立刻执行副作用
  scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
} else {
  // default: 'pre'
  scheduler = () => {
    //如果当前组件状态是已更新完成，则会将 job 推入一个 queuePreFlushCb 队列，这个队列会在组件下次重新更新之前执行
    if (!instance || instance.isMounted) {
      queuePreFlushCb(job)
    } else {
      // with 'pre' option, the first call must happen before
      // the component is mounted so it is called synchronously.
      //如果执行这里表示此时是处于setup()函数执行时（组件刚开始初始化）
      job()
    }
  }
}
...
}
```

`scheduler` 是一个调度器函数，负责调度执行 `job` 。`flush` 是 `options` 的一个配置属性，默认等于 `pre` 表示每次都在组件更新之前重新运行
副作用函数，还可以手动指定值为 `sync` 和 `post` ，`sync` 表示在组件每次更新时同步执行副作用函数，`post` 则是在组件更新之后执行副作用函数，
因此通过为 `job` 指定不同属性可以控制副作用执行的时机，`flush` 对于 `watch` 和 `watchEffect` 都适用。

```js
function doWatch(
  source,cb,{ immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ,instance = currentInstance
) {
  ...
       //创建侦听函数
        const runner = effect(getter, {
          lazy: true,
          onTrack,
          onTrigger,
          scheduler
      });
      //将侦听器收集进当前组件的全局属性effects（数组）中，我猜跟组件卸载时去停止侦听器有关
      recordInstanceBoundEffect(runner);
      // initial run
      //如果cb副作用回调存在，表示是watch，如果 options 还制定了 immediate 为 true,说明要求是侦听函数初始化完成立即执行一次副作用，默认是懒执行（在源数据被改变时候才去执行副作用）
      if (cb) {
        //立即执行副作用
          if (immediate) {
              job();
          }
          //默认懒执行
          else {
              oldValue = runner();
          }
      }
      //组件更新完成后再去初始化执行 `watchEffect` 的侦听函数
      else if (flush === 'post') {
          queuePostRenderEffect(runner, instance && instance.suspense);
      }
      //组件初始化完成之前，也就是侦听器函数初始化完成就立刻执行一次副作用（watchEffect）
      else {
          runner();//执行 effect
      }
      //返回一个执行后会停止侦听的函数
      return () => {
          stop(runner);
          if (instance) {
              remove(instance.effects, runner);
          }
      };
  ...
}
```

最后一段了，下来是调用 `effect.ts` 文件中的 `effect` 方法去创建侦听函数，侦听函数创建好以后会被返回，这里用 `runner` 来接收，所以当执行 `runner` 函数时候就表示侦听器被触发了，此时此刻要么是初始化时的依赖收集，要么就是值变了引起的依赖更新，最后 `doWatch` 函数会返回一个可以用来显式停止侦听的函数。它内部通过调用 stop 方法，来解除侦听器中的所有依赖，从而达到解除侦听的效果。

好了，到这里我们就把 `doWatch` 函数内部的执行流程大致的分析完了，`doWatch` 内部其实就是一些围绕侦听器所做的初始化工作，但是我们似乎还不清楚侦听函数的具体创建过程。所以趁热打铁，这就去`effect.ts` 里找 `effect` 方法，它就是去创建一个侦听函数的入口。

### effect

```js
//判断传入的fn是否已经是一个侦听函数了,判断标识为_isEffect属性,如果不是,则没有该属性标识
export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

//创建侦听函数的工厂函数effect
export function effect<T = any>(
  fn: () => T, //包装了源数据的原始函数
  options: ReactiveEffectOptions = EMPTY_OBJ //配置项，可以是 { immediate, deep, flush, onTrack, onTrigger }
): ReactiveEffect<T> {
  //如果传入的 fn 源数据函数已经是一个侦听函数了(创建过了)那此时它内部会挂载有一个raw属性,用来缓存原函数体,
  //当再次被传入时会自动获取到其内部的源函数,然后会使用源函数创建一个新的侦听函数，所以effect始终会返回一个新创建的侦听函数。
  if (isEffect(fn)) {
    fn = fn.raw
  }
  //执行创建的函数
  const effect = createReactiveEffect(fn, options)
  //lazy 是 options 选项的一个配置属性，如果 为true则会懒执行副作用，反之会在侦听函数创建完后立即执行一次副作用
  //vue组件实例中，lazy属性默认是true（在vue.global.js中会看到）
  if (!options.lazy) {
    effect()
  }
  //返回侦听函数
  return effect
}
```

回到 `effect.ts` 文件来看下 `effect` 函数，首先会接收两个参数 `fn` 源数据函数和 `options` 配置选项，这两个参数都是我们手动传入的。
然后会调用 `isEffect` 这个方法对 `fn` 进行判断看是否已经是一个 侦听函数了，如果是，则获取到它的源数据函数（保存在 `raw` 属性中）去执行创建，所以
也说明 `effect` 始终会返回一个新创建的侦听函数。下来调用 `createReactiveEffect` 去执行创建，最后会将创建好的侦听函数返回。

### createReactiveEffect

```js
let uid = 0 //id 标识，应该是用来标识唯一性的，不用去细究

//执行创建侦听函数
function createReactiveEffect<T = any>(
  fn: () => T, //源数据函数
  options: ReactiveEffectOptions //配置项 可以是 { immediate, deep, flush, onTrack, onTrigger }
): ReactiveEffect<T> {
  //初始化一个侦听函数，函数本质也是对象，所以可以挂载/扩展一些有用的属性
  const effect = function reactiveEffect(): unknown {
    //active 是 effect 侦听函数上扩展的一个属性，默认 active 为true,表示一个有效的侦听函数，当侦听属性的值发生变化时就会去
    //执行副作用，active 为false 的唯一时机是 stop方法触发，就是上面这个stop函数，此时，侦听函数就会失去侦听的能力，即响应性失效
    if (!effect.active) {
      //scheduler 是自定义调度器，用来调度触发侦听函数，会看到如果侦听函数失效后，如果自定了调度器，那么会直接返回undefined来终止
      //程序继续进行，如果没有自定义调度器，则执行源数据函数，这时候因为依赖都被移除掉了，因此是不会触发依赖收集操作，相当于执行了一次普通的
      //函数调用而已
      return options.scheduler ? undefined : fn()
    }
    //这里进行一次effectStack 中是否有 effect 判断的目的是为了防止同一个侦听函数被连续触发多次引起死递归。
    //假如此时正在执行副作用函数，该函数内部有修改依赖属性的操作，修改会触发 trigger， 进而
    //会再次触发侦听函数执行，然后副作用函数执行，这样当前的副作用函数就会无限递归下去，因此为了避免此现象发生，就会在副作用
    //函数执行之前进行先一次判断。如果当前侦听函数还没有出栈，就啥也不执行。
    if (!effectStack.includes(effect)) {
      //cleanup 函数的作用有两个，1：会移除掉依赖映射表(targetMap)里面的effect侦听器函数（也叫依赖函数），2：清空effect侦听函数中的deps
      //会发现 cleanup 操作是在每次即将执行副作用函数之前执行的，也就是在每次依赖重新收集之前会清空之前的依赖。这样做的目的是为了保证
      //依赖属性时刻对应最新的侦听函数。
      cleanup(effect)
      try {
        //当前effect侦听函数 入栈,并激活设置为 activeEffect
        enableTracking()
        effectStack.push(effect)
        activeEffect = effect
        //fn为副作用函数,若该函数里的响应式对象有属性的访问操作,则会触发getter,getter里会调用track()方法,进而实现依赖的重新收集
        return fn()
      } finally {
        //副作用函数执行完后,当前effect副作用函数出栈,并撤销激活态
        effectStack.pop()
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  //函数也是对象类型,因此可以给effect侦听扩展一些有用的属性
  effect.id = uid++ //id 唯一标识
  effect.allowRecurse = !!options.allowRecurse //是否允许递归（这个属性本意是用来控制侦听函数是否可以递归执行，但是实际发现并无卵用即使为true）
  effect._isEffect = true //是侦听函数标识，如果有此属性表明已经是一个侦听函数了
  effect.active = true //控制侦听函数的响应性，为false将失去响应性
  effect.raw = fn //缓存 fn 源数据函数
  effect.deps = [] //存储依赖dep。
  effect.options = options //可配置选项
  return effect//将创建好的侦听函数返回
}

// 清除依赖，该方法会在侦听函数每次将要执行副作用函数前或触发stop()函数时调用，用来清除依赖的
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}
```

`createReactiveEffect` 方法接收两个参数，这两个参数都是从 `effect` 函数传递过来的，所以就不释义了。该方法内部会初始化一个 `reactiveEffect` 函数，这个函数就是侦听函数。因为函数本质也是对象类型，因此在其上挂载/扩展一些有用的属性（属性释义可以看注释），最后将创建好的侦听函数返回。这样一个侦听函数就被创建好了。如果是从 `vue.global.js` 过来的，这里的被返回出去的 `effect` 就会被 `runner` 接收保存起来。（侦听函数内部执行我们在下面触发的时候再回过头来分析下，这样可以保持一个逻辑的连贯性）。

```js
// vue.global.js
 function doWatch(source, cb, { immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ, instance = currentInstance) {
   ...
       //runner 保存的就是 reactiveEffect 方法返回的 effect侦听函数
         const runner = effect(getter, {
          lazy: true,
          onTrack,
          onTrigger,
          scheduler
      });
      ...
 }
```

## 依赖收集

为了好说明，假设我们现在定义了这样的一个 `watchEffect` 和 `watch`。

```js
const count = ref(0)
const state = reactive({ count: 0 })
let dump, dump1

watchEffect(() => {
  dump = count.value
})

count.value = 1

watch(
  () => state.count,
  (count, prevCount) => {
    dump1 = count
  }
)

state.count = 1
```

先是定义了两个响应式数据 `count`，`state`,然后定义两个变量 `dump`,`dump1`。再是两个侦听函数，先是侦听函数初始化，这个过程中默认会执行一次依赖收集，然后我们来修改响应式数据，这个修改动作会下发更新信号给侦听函数，侦听函数侦听到后去执行副作用函数从而实现依赖更新。看着分析是挺有道理的，
但到底是不是这样的，我们还是来走下流程，窥探下执行细节比较稳妥。

### track

当访问响应式数据时 `track` 方法会被触发，去执行一次依赖收集。

```js
//依赖收集函数，当响应式数据属性被访问时该函数会被触发,从而收集有关访问属性的侦听函数（也叫依赖函数）effect
//target:原始目标对象（代理对象所对应的原始对象），type: 操作类型，key：访问属性名
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 如果shouldTrack状态为false，或当前无激活态侦听函数触发，则不去收集依赖（说明没有可收集的依赖）
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  //targetMap 是一个WeakMap集合，也叫依赖映射表(容器)，以原始目标对象为 key，depsMap(是一个Map集合)为value进行存储
  //depsMap中又以访问属性为 key，dep(是一个Set集合，自带去重功能)为value进行存储。dep集合中会存放 effect 侦听函数，
  //这些侦听函数也可以被称为访问属性的依赖函数，当访问属性值发生变化时依赖函数就会被触发。

  //获取依赖map
  let depsMap = targetMap.get(target)
  //如果依赖map不存在,则去初始化一个
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  //依赖map中获取访问属性对应的依赖集合
  let dep = depsMap.get(key)
  //如果不存在依赖集合，则去初始化一个
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  //检测dep依赖集合中是否有当前激活态的侦听函数，如果没有则把它存进去（这个过程就叫依赖收集）
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    //activeEffect 其实是当前正在执行的激活态的 effect侦听函数，这一步将存储访问属性有关的所有依赖函数的dep集合push进
    //当前侦听函数的deps（数组）中，建立了一个双向映射关系，这个双向映射关系会在每次副作用函数即将执行前的 cleanup操作时发挥作用
    //会将先前收集进depsMap 里所有访问属性的dep集合中该侦听函数（依赖函数）移除掉。然后在执行副作用函数的时候再次执行进track函数时重新
    //收集回来，这样的操作看似有点蛋疼，但经过细品后确实不是蛋疼所为，而是为了保证依赖的最新性。
    activeEffect.deps.push(dep)

    //只有开发环境下，才去触发相应的钩子函数(调试钩子)
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}
```

`track` 方法接收三个参数 `target`：原始目标对象（代理对象所对应的原始对象），`type`： 操作类型，`key`：访问属性名。方法内首先会进行一次依赖可收集判断，如果 `shouldTrack` 开关状态为 `false`，或当前无激活态侦听函数触发，则不去收集依赖（说明没有可收集的依赖）。下来是一系列关于依赖映射表（容器）存储内容存在性判断和创建存储过程，最终会生成这样一个映射表结构：

```js
WeakMap<Target, Map<string | symbol, Set<ReactiveEffect>>>

[[target1,[[key1,[effect1,effect2,...],[key2,[effect1,effect2,...],...]]],[target2,[[key1,[effect1,effect2,...],[key2,[effect1,effect2,...],...]]],...]
```

看起来可能不是很直观，那就描述下吧：首先会创建一个 `WeakMap` 类型的依赖收集容器 `targetMap`，这个容器是个顶级容器，所有依赖相关的东西都会安排进它里面。然后 `targetMap` 里面又会以不同 `target` 原始目标对象为 `key` ,`depsMap`（`Map` 集合）为 `value` 将收集容器进行区间划分。`dempsMap`中又会以传入的访问属性名为 `key` ,`dep`（`Set` 集合，自带去重功能）为 `value` 再次对 `dempsMap` 进行区间划分，最后将当前设置为激活态的 `effect`侦听函数（依赖函数）存入 `dep`集合中。这样不同目标对象下不同访问属性的所有依赖函数就被收集完成了，你看被安排的明明白白！。
然后说一个小细节`activeEffect.deps.push(dep)` ，会发现最后也会将 `dep` 往每一个 `effect` 的 `deps` 数组中存入一份，这个操作有啥作用呢？
不卖关子了，就直接说了，其实这一步目的是在每一个侦听函数和依赖映射表间建立了一个双向映射关系，这个双向映射关系会在每次副作用函数即将执行前的 `cleanup` 操作发挥作用。会将先前收集进 `depsMap` 里所有访问属性的 `dep` 集合中该侦听函数（依赖函数）移除掉。然后在执行副作用函数的时候再次执行 `track` 时重新收集回来，这样的操作看似有点蛋疼，但经过细品后的确不是蛋疼行为，这是为了保证依赖的最新性而有意为之。

## 依赖更新
### trigger

分析完了依赖收集后，下来就是触发依赖更新了，我们来看下执行过程, `trigger` 方法有点略长，哈哈哈。

```js
//触发依赖更新函数
export function trigger(
  target: object, //原始目标对象（代理对象所对应的原始对象）
  type: TriggerOpTypes, //操作类型
  key?: unknown, //要修改/设置的属性名
  newValue?: unknown, //新属性值
  oldValue?: unknown, //旧属性值
  oldTarget?: Map<unknown, unknown> | Set<unknown> //貌似只会在开发模式的调试下用到，不用去管
) {
  //获取目标对象在依赖映射表中对应的映射集合depsMap
  const depsMap = targetMap.get(target)
  //如果depsMap不存在,说明未收集过有关该原始对象的属性依赖,直接返回,不用去触发依赖更新
  if (!depsMap) {
    // never been tracked
    return
  }

  //初始化一个effects集合 (set集合)用来存放要被执行的侦听函数（依赖函数）
  const effects = new Set<ReactiveEffect>()
  //add effect into effects
  //add 是将 effect 侦听函数 添加进 effects 集合的添加方法
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    //effectsToAdd 其实就是从depsMap中执行属性对应的dep集合，里面存放的是一个个effect侦听函数
    if (effectsToAdd) {
      //执行遍历添加
      effectsToAdd.forEach(effect => {
        //添加条件： 要添加的侦听函数需要是一个非激活态，或者 allowRecurse 配置属性为true,才可以添加
        //但是单测实例时发现 allowRecurse 属性无论是 true or false 侦听函数effect都不会发生递归，因此
        //我感觉这个属性是多余的。
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }
  //如果操作类型为 clear,则将传入属性相关的所有依赖函数都触发，因为清空操作会清空整个集合，所以每一个集合属性的依赖都有影响
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
    //如果是修改数组长度操作,则将depsMap中有关 length 对应的依赖项以及数组中索引不大于新数组长度的下标对应的依赖添加 进effects中
    //因为数组长度变了，数组原来所有不大于新长度的索引对应的元素都会被重新设置一次，因此会触发依赖更新
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    //如果能进else说明肯定是SET | ADD | DELETE 中的某一种操作，若key不为 undefined，说明key是一个有效的属性，则获取该属性对应的所有依赖函数
    //添加进 effects 集合
    if (key !== void 0) {
      //void 0 = undefined
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    //这里先回顾下什么情况下会收集  ITERATE_KEY 和 MAP_KEY_ITERATE_KEY 为 key 的依赖，
    //1. baseHandlers.ts -> ownKeys 捕获方法中，这个方法被触发的时机是监听到Object.keys()被调用。
    //2. collectionHandlers.ts -> 插装方法 size，迭代方法 ['keys', 'values', 'entries',forEach, Symbol.iterator]中。获取集合长度.size 时触发 size方法，调用 Map,Set集合的迭代方法（keys,values,entries,forEach,for...of 等）。
    //ADD 表示新增属性操作，DELETE 表示删除属性操作 ，SET 表示修改属性操作。不同的操作类型下会根据目标对象的类型不同去触发更新对应的迭代依赖
    //这些迭代依赖之所以要去更新，是因为当前的操作会对收集的依赖有影响，如果不去更新，那就不能保证依赖数据的最新。
    switch (type) {
      //新增属性操作
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      //删除属性操作
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      //修改属性操作
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  //更新依赖函数的执行方法
  const run = (effect: ReactiveEffect) => {
    //开发模式下的调试钩子函数
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    //如果侦听函数的options配置选项上挂载了 scheduler 调度器，则使用调度器去执行侦听函数，否则直接执行侦听函数
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }
  //遍历effects集合，执行侦听函数的更新。
  effects.forEach(run)
}
```

`trigger` 方法内部首先从依赖映射表 `targetMap` 中获取到当前原始目标对象下的 `depsMap` 依赖集合，如果 `depsMap` 不存在,说明未收集过有关该原始对象的属性依赖,直接返回,不用去触发依赖更新。
然后往下走，会初始化一个 `effects` 集合 (`set` 集合,自带去重功能)用来存放要被执行的侦听函数（依赖函数），这里为啥用 `set` 集合呢，因为 `set` 集合自带去重功能，有可能出现添加进的依赖函数重复现象，那用 `set` 就可以自动过滤掉。
下来定义了一个 `add` 函数，这个函数的作用就是将 `effect` 侦听函数添加进 `effects` 集合的。这里关于 `add` 方法内部有一个细节，就是侦听函数的添加条件：`侦听函数需要是一个非激活态，或者 allowRecurse 配置属性为true`。但是单测实例时发现 `allowRecurse` 属性无论是 `true` or `false` 侦听函数 `effect` 都不会发生递归，为啥这个属性不生效呢，往回翻来看下 `effect` 函数有这莫一段代码 。

```js
  const effect = function reactiveEffect(): unknown {
    ....
        if (!effectStack.includes(effect)) {...}
    ...
  }
```

即使将等于 `activeEffect`的 `effect` 添加进了 `effects` 集合中，然后到了执行该侦听函数这一步，也会被上面这个 if 条件拦住，所以个人感觉 `allowRecurse` 这个属性是多余的。那此时也衍生出两个个问题，**什么时候 effect 等于 activeEffect ？** **如果不加 if 判断拦截，结果如何？** 这两个问题先不急，等下面分析到 effect 函数执行的时候就明白了。

下来是一系列对传入的 `type` 操作类型和 `key` 键名的判断，最终目的是将对应的 `dep` 依赖集合添加进 `effects` 集合中，基本也没啥太多好说的，只不过有一个点需要注意下，就是这里：

```js
// also run for iteration key on ADD | DELETE | Map.SET
//这里先回顾下什么情况下会收集  ITERATE_KEY 和 MAP_KEY_ITERATE_KEY 为 key 的依赖，
//1. baseHandlers.ts -> ownKeys 捕获方法中，这个方法被触发的时机是监听到Object.keys()被调用。
//2. collectionHandlers.ts -> 插装方法 size，迭代方法 ['keys', 'values', 'entries',forEach, Symbol.iterator]中。获取集合长度.size 时触发 size方法，调用 Map,Set集合的迭代方法（keys,values,entries,forEach,for...of 等）。
//ADD 表示新增属性操作，DELETE 表示删除属性操作 ，SET 表示修改属性操作。不同的操作类型下会根据目标对象的类型不同去触发更新对应的迭代依赖
//这些迭代依赖之所以要去更新，是因为当前的操作会对收集的依赖有影响，如果不去更新，那就不能保证依赖数据的最新。
switch (type) {
  //新增属性操作
  case TriggerOpTypes.ADD:
    if (!isArray(target)) {
      add(depsMap.get(ITERATE_KEY))
      if (isMap(target)) {
        add(depsMap.get(MAP_KEY_ITERATE_KEY))
      }
    } else if (isIntegerKey(key)) {
      // new index added to array -> length changes
      add(depsMap.get('length'))
    }
    break
  //删除属性操作
  case TriggerOpTypes.DELETE:
    if (!isArray(target)) {
      add(depsMap.get(ITERATE_KEY))
      if (isMap(target)) {
        add(depsMap.get(MAP_KEY_ITERATE_KEY))
      }
    }
    break
  //修改属性操作
  case TriggerOpTypes.SET:
    if (isMap(target)) {
      add(depsMap.get(ITERATE_KEY))
    }
    break
}
```

通过判断三种不同 `type` 类型 ，然后去将迭代依赖添加进 `effects` 集合中，然后去更新它，那么**为啥需要更新迭代依赖呢？这些依赖什么时候收集的呢？**
首先先说收集的地方。

- `baseHandlers.ts -> ownKeys` 捕获方法中，这个方法被触发的时机是监听到 `Object.keys()` 被调用。
- `collectionHandlers.ts -> 插装方法 size`，迭代方法 `['keys', 'values', 'entries',forEach, Symbol.iterator]`中。获取集合长度 `.size` 时触发 `size` 方法，调用 `Map,Set` 集合的迭代方法（`keys,values,entries,forEach,for...of` 等）。

如果你仔细分析这里每种类型 `case` 下的判断条件会发现不同类型的操作都会对其下的依赖产生影响。我们来举个例子吧；

```js
const state = reactive({ a: 1, b: 2 })
let keys
watchEffect(() => {
  keys = Object.keys(state)
})

state.c = 3
```

我们先定义了一个响应式对象 `state` 然后在 `watchEffect` 的副作用函数中执行 `Object.keys(state)`。 首先副作用函数会执行一次，执行过程中由于 `Object.keys` 调用会触发 `ownKeys` 捕获方法。`ownKeys` 方法内又会触发 `track` ，从而进行依赖收集，这里分为两种情况，数组和对象，如果是数组，
会将 `length` 作为 `key` ,如果是对象则用 `ITERATE_KEY` 常量作为 `key`，将它们依赖关系存入 `depsMap` 集合中，我们称之为**迭代依赖**关系。

```js
//拦截 Object.keys 方法
function ownKeys(target: object): (string | number | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}
```

然后我们新添加一个属性 `c`, 属性值为 `3`，新增属性就会触发 `trigger` ，进而代码一定会执行到我们刚才说的 `type` 类型判断哪里，这个时候 `type` 的类型是 `ADD`。刚才我们说过了，`ITERATE_KEY` 的依赖是又 `Object.keys` 方法引起收集的，那添加了新属性，是不是得重新执行下包含有 `Object.keys` 逻辑的依赖函数，进而更新 `keys` 变量的值， 不然 `keys` 变量中保存的 `key` 就不是最新的了。
同样对于数组如果通过 `push` 方法或者设置索引的方式给数组新增元素，那也会引起 `length` 下的依赖更新。还有集合类型，我们就不一一举例子了，道理都是一样的。哦，对了，这里补充一点就是 `effects` 集合采用 `Set` 集合类型，是因为它自带元素去重能力，依赖函数 `add` 过程中肯定会有重复的情况，有了它就避免了重复现象发生。

`trigger` 方法的最后定义了一个用来更新依赖的执行方法 `run`，然后就紧接着去遍历 `effects` 集合，执行侦听函数的更新。这样 `trigger`就分析完了。但是我们的篇章分析还没有完，下来伴随着执行，我们将执行过程再看看。

开始遍历 `effects` ，然后依次拿到事先存好的 `effect` 侦听函数，放进 `run` 方法中执行，会看到 `run` 方法入参接收的就会 `effect`。
`run` 方法中第一个 `if` 判断不用管，是开发模式下的一个关于调试的。我们直接看 第二个 `if` ，这个 `if` 判断意思是说侦听函数的 `options` 配置选项上如果挂载了 `scheduler` 调度器，则使用调度器去执行侦听函数，否则直接执行侦听函数。之前在 `vue.global.js` 中分析过，会给 `options` 上挂载一个 `scheduler`，你看，这里就是使用的地方，那我们就辗转到 `scheduler` 中去。

```js
function doWatch(
  source,cb,{ immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ,instance = currentInstance
) {
  ...
  let scheduler
if (flush === 'sync') {
  //直接等于job，会在组件更新时执行，可以与 pre对比，没有对于实例以及实例目前的状态判断，因此会组件更新时同步执行副作用
  scheduler = job
} else if (flush === 'post') {
  //组件更新后执行，会发现job每次都会被先推入一个队列而不是去立刻执行副作用
  scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
} else {
  // default: 'pre'
  scheduler = () => {
    //如果当前组件状态是已更新完成，则会将 job 推入一个 queuePreFlushCb 队列，这个队列会在组件下次重新更新之前执行
    if (!instance || instance.isMounted) {
      queuePreFlushCb(job)
    } else {
      // with 'pre' option, the first call must happen before
      // the component is mounted so it is called synchronously.
      //如果执行这里表示此时是处于setup()函数执行时（组件刚开始初始化）
      job()
    }
  }
}
...
}
```

将代码再次 bia 出来，加深下印象。我们就用默认模式（`pre`）分析吧（其实都差不多，只是执行的时机不同罢了）。这里如果是组件已经渲染完成后触发的，
那么会走 `if` 逻辑，如果是在组件挂载之前（比如 setup），就走 `else` 逻辑，为了简单明了，我们就 `else` 分析吧。会发现又去调用 `job` 方法。我们依然把 `job` 也 bia 出来。

```js
const job = () => {
  //runner就是侦听函数,如果active属性为false说明已经停止侦听,就直接返回,不去执行副作用
  if (!runner.active) {
    return
  }
  //cb是 watch 方法中的 副作用函数,如果存在就去执行它(副作用),如果不存在,说明是 watchEffect,则去执行runner函数,也就是effect自身
  if (cb) {
    // watch(source, cb)
    const newValue = runner()
    if (deep || forceTrigger || hasChanged(newValue, oldValue)) {
      // cleanup before running cb again
      if (cleanup) {
        cleanup()
      }
      callWithAsyncErrorHandling(cb, instance, 3 /* WATCH_CALLBACK */, [
        newValue,
        // pass undefined as the old value when it's changed for the first time
        oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
        onInvalidate
      ])
      oldValue = newValue
    }
  } else {
    // watchEffect
    runner() //就是执行 `effect.ts` 中的 effect()
  }
}
```

`job` 内部分两种情况，有 `cb` 和没有 `cb`，这里之前也讲过了，其实就是 `watch` 和 `watchEffect` 的区别。如果是 `watch` 会走 `if` 判断，调用 `runner` （侦听函数）返回执行了原始函数返回的新属性值（这个过程中会收集新的依赖），`cleanup` 方法用来清除上次副作用函数执行后留下的还在生效的副作用。下来 调用 `callWithAsyncErrorHandling` 方法，执行副作用函数。
否则就是 `watchEffect` ，走 `else` 逻辑，`watch` 下我们没有分析 `effect` 侦听函数内部具体执行过程，一笔代过了，其实我是想放到这说呢，不要问我为毛，就是乐意，哈哈哈，那走吧，我们又回到 `effect.ts` 里去。

> 找啊找啊找朋友，找到一个好朋友。。。

```js
//初始化一个侦听函数，函数本质也是对象，所以可以挂载/扩展一些有用的属性
const effect = function reactiveEffect(): unknown {
  //active 是 effect 侦听函数上扩展的一个属性，默认 active 为true,表示一个有效的侦听函数，当侦听属性的值发生变化时就会去
  //执行副作用，active 为false 的唯一时机是 stop方法触发，就是上面这个stop函数，此时，侦听函数就会失去侦听的能力，即响应性失效
  if (!effect.active) {
    //scheduler 是自定义调度器，用来调度触发侦听函数，会看到如果侦听函数失效后，如果自定了调度器，那么会直接返回undefined来终止
    //程序继续进行，如果没有自定义调度器，则执行源数据函数，这时候因为依赖都被移除掉了，因此是不会触发依赖收集操作，相当于执行了一次普通的
    //函数调用而已
    return options.scheduler ? undefined : fn()
  }
  //这里进行一次effectStack 中是否有 effect 判断的目的是为了防止同一个侦听函数被连续触发多次引起死递归。
  //假如此时正在执行副作用函数，该函数内部有修改依赖属性的操作，修改会触发 trigger， 进而会再次触发侦听函数执行，
  //然后副作用函数执行，这样当前的副作用函数就会无限递归下去，因此为了避免此现象发生，就会在副作用函数执行之前进行先一次判断。
  //如果当前侦听函数还没有出栈，就啥也不执行。
  if (!effectStack.includes(effect)) {
    //cleanup 函数的作用有两个，1：会移除掉依赖映射表(targetMap)里面的effect侦听器函数（也叫依赖函数），2：清空effect侦听函数中的deps
    //会发现 cleanup 操作是在每次即将执行副作用函数之前执行的，也就是在每次依赖重新收集之前会清空之前的依赖。这样做的目的是为了保证
    //依赖属性时刻对应最新的侦听函数。
    cleanup(effect)
    try {
      //当前effect侦听函数 入栈,并激活设置为 activeEffect
      enableTracking()
      effectStack.push(effect)
      activeEffect = effect
      //fn为副作用函数,若该函数里的响应式对象有属性的访问操作,则会触发getter,getter里会调用track()方法,进而实现依赖的重新收集
      return fn()
    } finally {
      //副作用函数执行完后,当前effect副作用函数出栈,并撤销激活态
      effectStack.pop()
      resetTracking()
      activeEffect = effectStack[effectStack.length - 1]
    }
  }
}
```

第一步对当前执行的侦听函数响应状态进行判断，只有具有响应性的侦听函数才可以被调度执行。那什么时候失去响应性呢？就是 `stop`（用来显式停止侦听）方法被调用时，或者组件卸载时。第二步对 `effectStack` 中是否已经存在即将要执行的 `effect` 判断，这一步的目的是为了防止同一个侦听函数被连续触发多次引起死递归。还记得上面当我我们抛出来的两个问题吗？ **什么时候 effect 等于 activeEffect ？** **如果不加 if 判断拦截，结果如何** 。那现在我们就来分析分析。还是先举个栗子吧。

```js
it('could control implicit infinite recursive loops with itself when options.allowRecurse is true', () => {
  const counter = reactive({ num: 0 })

  const counterSpy = jest.fn(() => counter.num++)
  effect(counterSpy, { allowRecurse: true })
  expect(counter.num).toBe(1)
})
```

这个单测栗子用来测试将 `!effectStack.includes(effect)` 判断去掉会发生神马情况，我们将 `if` 判断改成 `true`，然后 `run` 单测
实例会发现报错: `RangeError: Maximum call stack size exceeded` （堆栈溢出）。这个就是如果不加 `if` 判断导致的结果了。那是如何发生的呢，我们
来分析下单测实例执行。
定义一个响应式对象 `counter` 调用 `effect` 函数，执行初始化，侦听函数初始化完成会立即执行一次。`if` 判断为 `true` ，直接进来，副作用函数 `fn`
执行前都先执行一次 `cleanup`操作。 `cleanup` 方法内部我们来看下：

```js
// 清除依赖，该方法会在侦听函数每次将要执行副作用函数前或触发stop()函数时调用，用来清除依赖的
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}
```

`effect` 侦听函数上挂载了一个 `deps` 属性，这个属性保存的是所有包含该侦听函数的 `dep` 集合，这样在侦听函数和依赖集合之前建立了一个双向映射的关系，
所以，当遍历 `deps`，移除掉每一个 `dep` 里的 `effect` 后，依赖集合里面的该侦听函数也就被移除掉了。从而实现清除依赖的目的。
先清除掉依赖后，下来将正在执行的 `effect` 侦听函数推入 `effectStack` 中，称为入栈， 并将其设置为激活态 `activeEffect` ，然后去执行副作用函数，单测实例这里这个副作用函数就是 `() => counter.num++` ，该函数内部是一个 `counter.num` 自增操作，先获取属性，触发一次 `gettter`，进而将依赖重新收集回来，这里就可以跟刚才的清除依赖呼应起来了，**每一次重新执行副作用之前将先前的依赖全部清除掉的作用就是为了保证依赖的最新性**。下来自增
操作时一个修改操作，因此会触发 `setter` 进而去触发依赖更新，那此时副作用函数还没有执行完成，`activeEffect` 仍然是这个 `effect`，当再次执行副作用
函数进来又会走到我们 的 `if` 判断，这个时候如果没有 `!effectStack.includes(effect)` 判断条件，就会继续重复上步流程，这样就陷入了侦听函数内部的
隐式递归，因此这个 `if` 判断是很关键的，它的作用就是为了**避免侦听函数内部的隐式递归** ，此时刚才那两个问题的答案就呼之欲出了吧。

伴随着单测实例，副作用函数内部的执行过程也分析完了，同时 `effect` 篇的内容也就全部分析完了，此时的感受就一句话，**写了好多字，哈哈哈**
