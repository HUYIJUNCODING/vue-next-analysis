## reactive 源码分析

### 前言

- reactive 是 vue3.0 中实现响应式系统最重要的方法之一，它接收一个普通对象然后返回该普通对象的响应式代理。
- 该响应式转换是“深层的”：会影响对象内部所有嵌套的属性，基于 ES6 的 Proxy 实现(Proxy 其实也是不支持嵌套代理，因此深层代理，也是递归出来的)。
- Proxy 是 reactive 内部的实现基础，她是直接代理整个对象，相较于 vue2.x 中的 Object.defineProperty 劫持对象的指定属性会显得格外省事和强大(毕竟拥有 13 种拦截方法，能力不是吹出来的)
- reactive 返回的代理对象不等于原始对象。建议仅使用代理对象而避免依赖原始对象(直接对原始对象进行读写操作，不会触发依赖更新和收集)

* [reactive篇源代码传送门](https://github.com/HUYIJUNCODING/vue-next-analysis/blob/master/packages/reactivity/src/reactive.ts)

### 源码分析

#### reactive

首先我们从最核心的方法 `reactive`开始。

```js
//reactive 函数类型声明，接受一个对象，返回一个不会深度嵌套的Ref类型数据
export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>

//reactive 函数实现
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  //如果传入的目标对象是一个只读响应式对象,则将其直接返回
  if (target && (target as Target)[ReactiveFlags.IS_READONLY]) {
    return target
  }
  //调用createReactiveObject创建目标对象对应的响应式对象
  return createReactiveObject(
    target, //目标对象
    false, //目标对象是否是只读的
    mutableHandlers, //可变普通对象的代理handler，Object和Array
    mutableCollectionHandlers // 可变集合对象的代理handler，Set、Map、WeakMap、WeakSet
  )
}

//创建响应式对象的方法，接收一个普通对象然后返回该普通对象的响应式代理。
function createReactiveObject(
  target: Target, //目标对象
  isReadonly: boolean, //目标对象是否是只读的
  baseHandlers: ProxyHandler<any>, //可变普通对象的代理handler，Object和Array
  collectionHandlers: ProxyHandler<any> // 可变集合对象的代理handler，Set、Map、WeakMap、WeakSet
) {
  //如果不是对象,则直接返回,非对象类型不能代理(开发环境下会给出警告)
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target is already a Proxy, return it.
  // exception: calling readonly() on a reactive object
  //如果目标对象已经是一个响应式代理了,则直接返回,(但是在响应式对象上调用readonly方法这种情况除外，意思是readonly可以继续处理响应式对象)
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // target already has corresponding Proxy
  //如果目标对象已经有了相应的proxy代理(首次 createReactive 时候会往 readonlyMap或者reactiveMap 存入rawObj -> proxy 关系,所以可以检测出来),
  //则从map集合里取出对应的代理对象（同一个原始对象只能有一个代理对象，不能重复代理）
  const proxyMap = isReadonly ? readonlyMap : reactiveMap
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
  // only a whitelist of value types can be observed.
  //getTargetType 方法内部会调用 targetTypeMap方法,然后会对target类型进行归类并返回其类型
  //Object,Array -> 1,Map,WeakMap,Set,WeakSet - > 2,其他无效类型(INVALID:无效类型)-> 0
  //如果传入的target类型无效则直接返回target
  const targetType = getTargetType(target)
  if (targetType === TargetType.INVALID) {
    return target
  }
  //创建并返回代理对象,这里需要注意集合类型和Object/Array的响应式handler(第二个参数),内部会有不同
  const proxy = new Proxy(
    target,
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers
  )
  //建立rawOject->proxy映射关系并存入 readonlyMap/reactiveMap
  proxyMap.set(target, proxy)
  return proxy
}
```

`reactive` 方法只能接收一个对象类型的参数作为入参，最终会返回这个传入对象的代理对象。在这个过程中会有一些判断。

- 1.如果传入的目标对象是一个只读响应式对象,则直接返回。
- 2.如果传入的不是对象,则直接返回,非对象类型不能代理(开发环境下会给出警告)
- 3.如果目标对象已经是一个响应式代理了,则直接返回。
- 4.如果目标对象已经有了相应的 proxy 代理，则从 readonlyMap/reactiveMap 中的映射表里取出代理对象然后返回。

如果以上条件都不满足，说明是一个原始对象则去 通过 new Proxy() 方法创建代理并存入映射表集合 map 中，这里有两点需要留一下。

- 1 对于已经是代理对象的入参，如果是通过调用 readonly 方法进来的，则不会被拦截掉，说明 readonly 可以继续处理响应式对象。
- 2.集合类型和 Object/Array 的响应式 handler(第二个参数),内部会有不同，为啥 handler 内部会有所不同呢，先卖个关子，分析到 collectionHandlers
  时候我们来分析揭晓。

这是创建一个可读写对象的响应式代理，过程中还会看到几个创建方法 `readonly`, `shallowReactive`, `shallowReadonly`,内部创建过程跟 `reactive`非常相似，简单看下吧

```js
//传入一个对象（响应式或普通）或 ref，返回一个原始对象的只读代理。一个只读的代理是“深层的”，对象内部任何嵌套的属性也都是只读的。
export function readonly<T extends object>(
  target: T
): DeepReadonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers
  )
}

// Return a reactive-copy of the original object, where only the root level
// properties are reactive, and does NOT unwrap refs nor recursively convert
// returned properties.
//只为某个对象的私有（第一层）属性创建浅层的响应式代理，不会对“属性的属性”做深层次、递归地响应式代理，而只是保留原样。
export function shallowReactive<T extends object>(target: T): T {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers
  )
}

// Return a reactive-copy of the original object, where only the root level
// properties are readonly, and does NOT unwrap refs nor recursively convert
// returned properties.
// This is used for creating the props proxy object for stateful components.
//只为某个对象的自有（第一层）属性创建浅层的只读响应式代理,不会做深层次、递归地代理，深层次的属性并不是只读的
export function shallowReadonly<T extends object>(
  target: T
): Readonly<{ [K in keyof T]: UnwrapNestedRefs<T[K]> }> {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    readonlyCollectionHandlers
  )
}
```

会发现与 `reactive` 创建响应式对象有两点不同： 1:指定模式不同，2: handler 不同，其余过程基本一样，这些差异化会在接下来的 `baseHandlers` 和`collectionHandlers`中体现出来，会发现 reactive 文件中代码量比较少，逻辑也比较易懂。其实这部分的关键逻辑基本都在 handler 中，分析 handler 才是重头戏，走着。

#### baseHandlers

首先先从 `mutableHandlers` 开始，其余模式的 handler 都是它的变种版

```js
//可变普通对象的代理handler
export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}
```

可以看到，`mutableHandlers` 有四个 trap 方法，我们就按照顺序一个个过吧，首先是 `get`。

##### get

```js
const get = /*#__PURE__*/ createGetter() //isReadonly = false, shallow = false
const shallowGet = /*#__PURE__*/ createGetter(false, true) //isReadonly = false, shallow = true
const readonlyGet = /*#__PURE__*/ createGetter(true) //isReadonly = true, shallow = false
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true) //isReadonly = true, shallow = true

//handler中的 get trap(陷阱)，通过createGetter函数返回
function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {// receiver:最初被调用的对象,通常是 proxy 本身
    //如果key为 '__v_isReactive'则返回 !isReadonly，判断代理对象是否是可响应的 (这里很有意思，不是直接返回true/false，而是借助isReadonly这个状态模式取反，很巧妙，同时也直观的反映只读类型的代理不是响应式的)
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
      //如果key为 '__v_isReadonly',则返回 isReadonly 状态的值,判断代理对象是否是只读的
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
      //如果 key 为 '__v_raw',并且 代理对象的 receiver 在 readonlyMap/reactiveMap 找的到
      //(说明是来获取proxy代理对象的rawObject的),
      //则返回代理对象对应的原始 target 对象(普通对象)
    } else if (
      key === ReactiveFlags.RAW &&
      receiver === (isReadonly ? readonlyMap : reactiveMap).get(target)
    ) {
      return target
    }

    //如果目标对象是数组,key是数组的内置方法名('includes', 'indexOf', 'lastIndexOf','push', 'pop', 'shift', 'unshift', 'splice')
    //并且当前key 在arrayInstrumentations 中找得到，那么返回arrayInstrumentations中key对应的方法
    const targetIsArray = isArray(target)
    if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
      //arrayInstrumentations 是一个对象，这个对象里面重写了与以上几个数组内置方法同名的方法，这样当访问这些内置方法时就会被重写的方法拦截。
      return Reflect.get(arrayInstrumentations, key, receiver)
    }
    //采用反射的方式 获取原始对象身上某个属性值，类似于 target[name]。
    const res = Reflect.get(target, key, receiver)
    // 如果是 获取 Symbol 对象中的类型为 symbol 的 内置方法 或者是获取原型对象，或者是获取ref对象上的 __v_isRef 属性的值，
    //都直接返回 获取到的属性值，而不去执行依赖收集。我的理解是这些都是没有必要进行依赖收集的，因为它们基本都是不可变的，只有可变的属性才有必须
    //去收集，因为当他们的值改变了，对应的依赖也要去更新
    if (
      isSymbol(key)
        ? builtInSymbols.has(key as symbol)
        : key === `__proto__` || key === `__v_isRef`
    ) {
      return res
    }
    //非只读模式，调用 track 去收集依赖
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }
    //浅层模式直接返回反射获取的原始对象属性值，无论是否是对象类型，都不去进行深度追踪
    if (shallow) {
      return res
    }

    //只有ref作为对象属性，才会解套ref，返回ref.value ，否则不能解套会返回ref对象，
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      //ref 解套不能应用于key为integer（整数）类型的数组，所以官方文档会说
      //当嵌套在 reactive Object 中时，ref 才会解套。从 Array 或者 Map 等原生集合类中访问 ref 时，不会自动解套
      //集合的handler在collectionHandlers中，因此这里只看到了为数组的情况
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    //如果获取到的属性值为object类型,则进一步进行响应式化处理(深度追踪)
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      //将返回值也转换为代理。进行isObject检查是为了是为了避免无效值警告。在这里惰性访问 readonly 和reactive 方法来将返回值进一步进行proxy 转换
      //以避免循环依赖的发生，其实将对象类型的属性值推迟到在这里去响应式转换，除了避免循环依赖，还可以提高性能，用的时候才去转嘛。
      return isReadonly ? readonly(res) : reactive(res)
    }
    return res
  }
}
```

细心的小伙伴可能会发现 `get` 方法是由 一个 叫 `createGetter` 返回的，而不是直接等于，为啥这样做嘞，因为多模式（只读模式，浅层模式,可变模式）下，getter 内部的劫持操作会有所差异，这些差异化动作就是由不同模式来区分的，因此需要在初始化 get 的时候能够动态传参来提前初始化好不同模式下的 getter。
然后我们来到 get 方法内部，首先是对 key 是否是 `ReactiveFlags` 里枚举常量标识进行判断,不同标识有不同含义，见下方注释

```js
//定义枚举常量标识
export const enum ReactiveFlags {
  SKIP = '__v_skip', //布尔类型，跳过 Proxy 的转换，被该属性标记的对象，不能被响应式化
  IS_REACTIVE = '__v_isReactive', //布尔类型，是否是一个响应式代理对象
  IS_READONLY = '__v_isReadonly', //布尔类型，是否是一个只读对象
  RAW = '__v_raw' //存储响应式对象的原始对象
}
```

然后是对目标对象是数组，key 为数组内置方法名时候的方法劫持操作，如果传入的 key 方法名在 `arrayInstrumentations` 对象中找得到，那就反射获取到这个复写的方法并返回（例如： arr.push()，就会执行这里的逻辑）

```js
//定义数组内置方法复写容器
const arrayInstrumentations: Record<string, Function> = {}
// instrument identity-sensitive Array methods to account for possible reactive
// values
//复写数组的查询内置方法，会放入 arrayInstrumentations 复写容器中
;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
  const method = Array.prototype[key] as any
  arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
    //这里的this是原始数组的proxy代理
    const arr = toRaw(this)
    for (let i = 0, l = this.length; i < l; i++) {
      track(arr, TrackOpTypes.GET, i + '')
    }
    // we run the method using the original args first (which may be reactive)
    const res = method.apply(arr, args)
    if (res === -1 || res === false) {
      // if that didn't work, run it again using raw values.
      return method.apply(arr, args.map(toRaw))
    } else {
      return res
    }
  }
})
// instrument length-altering mutation methods to avoid length being tracked
// which leads to infinite loops in some cases (#2137)
//复写数组的内置操作方法，会放入 arrayInstrumentations 复写容器中
;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
  const method = Array.prototype[key] as any
  arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
    pauseTracking()
    const res = method.apply(this, args)//这里的this是 原始数组的proxy代理
    resetTracking()
    return res
  }
})
```

对 数组的 `includes`, `indexOf`, `lastIndexOf`,`push`,`pop`,`shift`，`unshift`,`splice`内置方法做了复写。
看到这里大家是否有一个疑问呢，就是，对于数组的操作方法（push，pop，shift，unshift，splice）貌似并没有找到对应的 trap 劫持方法呢？这些方法可都是会改变数组结构和内容的。那既然扯到了这里，就一探究竟，最直接有效的方法就是去调试 demo（这部分其实应该放到 set 方法分析以后，为了保持连贯性，就在这里分析了吧）

```js
<script src="../../dist/vue.global.js"></script>

<div id="app">
    <div>{{count}}</div>
</div>

<script>
const { ref,createApp, reactive, computed, watchEffect, onMounted, onUnmounted } = Vue



createApp({
  setup () {
    const count = ref(0);
    const r = reactive([count,1,2,3])
    r.push(5)
    // onMounted(() => {})
    return {
        count
    }
  }

}).mount('#app')
</script>
```

例如这里我们写个 push 方法的 demo ,浏览器中打开，启动 debugger 调试，会发现先触发两次 get ,然后触发两次 set。虽然知道了结果，但是又引出一个问题，这个触发两次 get 然后再触发两次 set 是框架层面控制还是 Proxy 代理本身控制的，然后就又写了个比较单纯的 demo。

```js
const p = new Proxy([1, 2, 3], {
  get(target, key, receiver) {
    console.log(key, target[key], 'get')
    return Reflect.get(target, key, receiver)
  },
  set(target, key, value, receiver) {
    console.log(key, value, 'set')
    const result = Reflect.set(target, key, value, receiver)
    return result
  }
})

p.push(4)

//打印结果：
// push [Function: push] get
// length 3 get
// 3 4 set
// length 4 set
```

打印结果很直观的反映出触发的 trap 方法的顺序，不知道看到这个结果你们惊喜不惊喜，反正我是挺惊喜的。至于为什么是这样的，我目前也没有搞清楚，唉，流下了技术匮乏的泪水。有兴趣的小伙伴可以去探究下。
不仅如此，我再列举几个情况，大家看看

```js
const p = new Proxy([1, 2, 3], {
  get(target, key, receiver) {
    console.log(key, target[key], 'get')
    return Reflect.get(target, key, receiver)
  },
  set(target, key, value, receiver) {
    console.log(key, value, 'set')
    const result = Reflect.set(target, key, value, receiver)
    return result
  }
})

p.unshift(0)

//打印结果：
// unshift [Function: unshift] get
// length 3 get
// 2 3 get
// 3 3 set
// 1 2 get
// 2 2 set
// 0 1 get
// 1 1 set
// 0 0 set
// length 4 set
```

```js
const p = new Proxy([1, 2, 3], {
  get(target, key, receiver) {
    console.log(key, target[key], 'get')
    return Reflect.get(target, key, receiver)
  },
  set(target, key, value, receiver) {
    console.log(key, value, 'set')
    const result = Reflect.set(target, key, value, receiver)
    return result
  }
})

p.indexOf(3)

//打印结果：
// indexOf [Function: indexOf] get
// length 3 get
// 0 1 get
// 1 2 get
// 2 3 get
```

总结一下：

- `includes`, `indexOf`, `lastIndexOf` 只是查询，不涉及到修改，因此只会触发 get 劫持，
- `push`,`pop` 这两个方法先会触发两次 get(获取方法一次，获取 length 一次),pop 弹出，下来会执行一次获取最后一个元素，然后执行弹出，此时 length 改变，所以需要最后触发一次 set 劫持。push 因为是推入元素，先给索引下标赋一次值触发一次 set 劫持，接着 length 改变，会再触发一次 set 劫持。
- `shift`，`unshift`,`splice` 同样 也会先触发两次 get(获取方法一次，获取 length 一次)，然后都可以修改数组，因此会触发 set ，不过这几个方法有点意思，一般执行的过程中会先 get ，然后 set，我想 get 应该是为了定位目标去查找触发的，set 是设置值时候触发的,过程中会触发多次 set，因此这个在源码中会多次触发 `trigger`,其实想一想也合理，`shift`，`unshift`,`splice` 这样的方法会影响数组原来索引对应的 value 值发生移位或变更，原来索引对应的值变了，
  依赖也应该去被更新以保持永远同步最新值，但是就是觉得 set 太过于频繁，是否会有性能上的开销。这里还有一个点，就是这些修改方法，最后都会触发 length 改变引起的 set 劫持，但是实际上发现，对于 `push` 方法 执行 length 触发的 set 逻辑时，获取的旧 length 已经是新的值了，由于 `value === oldValue`，这次并不会触发 `trigger`。而对于 其余几个修改方法，最后的 length 触发的 set 时候 `value ！== oldValue` 会触发一次 `trigger`。

这些操作方法的差异化应该是数组本身底层的规范所导致的，感觉比较复杂，不知道其底层的原因也不影响源码的分析，所以就不去深究了，太复杂了。回到开始的疑问，原来这些操作数组的方法背后是通过 触发 get 和 set 方式从而进行依赖收集和更新的，难怪不需要显示的定义对应的 trap 劫持方法。而且这是 Proxy 本身的特性，并不是框架层所做的，顿时觉得，Proxy 真的是太强大了，哈哈哈!

下来 是利用反射获取到原始对象上的属性值,然后进行不同模式判断，决定是否调用 `track` 去依赖收集，以及对属性值进行类型判断，如果是 Ref 类型则
解套赋值，如果是对象类型，则去进行响应式转换，这里对对象类型的属性值响应式转换也被称为 `惰性转换`，为啥会这样设计呢，按照源码注释的意思是，是为了避免循环依赖的发生，同时个人认为还有一点就是提高性能，只有在用到的时候才去做响应式转换，没有用到就不转了。最后将获取到的 value 返回。

```js
    //反射的方式获取原始对象身上某个属性值，类似于 target[name]。
    const res = Reflect.get(target, key, receiver)
    // 如果是 获取 Symbol 对象中的类型为 symbol 的 内置方法 或者是获取原型对象，或者是获取ref对象上的 __v_isRef 属性的值，
    //都直接返回 获取到的属性值，而不去执行依赖收集。我的理解是这些都是没有必要进行依赖收集的，因为它们基本都是不可变的，只有可变的属性才有必须
    //去收集，因为当他们的值改变了，对应的依赖也要去更新
    if (
      isSymbol(key)
        ? builtInSymbols.has(key as symbol)
        : key === `__proto__` || key === `__v_isRef`
    ) {
      return res
    }
    //非只读模式，调用 track 去收集依赖
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }
    //浅层模式直接返回反射获取的原始对象属性值，无论是否是对象类型，都不去进行深度追踪
    if (shallow) {
      return res
    }

    //只有ref作为对象属性，才会解套ref，返回ref.value ，否则不能解套会返回ref对象，
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      //ref 解套不能应用于key为integer（整数）类型的数组，所以官方文档会说
      //当嵌套在 reactive Object 中时，ref 才会解套。从 Array 或者 Map 等原生集合类中访问 ref 时，不会自动解套
      //集合的handler在collectionHandlers中，因此这里只看到了为数组的情况
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    //如果获取到的属性值为object类型,则进一步进行响应式化处理(深度追踪)
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      //将返回值也转换为代理。进行isObject检查是为了是为了避免无效值警告。在这里惰性访问 readonly 和reactive 方法来将返回值进一步进行proxy 转换
      //以避免循环依赖的发生，其实将对象类型的属性值推迟到在这里去响应式转换，除了避免循环依赖，还可以提高性能，用的时候才去转嘛。
      return isReadonly ? readonly(res) : reactive(res)
    }
    return res
```

至此，关于 get 就分析完了，下来分析 set

##### set

```js
//定义不同模式下的 setter
const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

//handler中的 set trap(陷阱)，通过createSetter函数返回
function createSetter(shallow = false) {
  return function set(
    target: object, //原始对象
    key: string | symbol, //key
    value: unknown, //新属性值
    receiver: object //最初被调用的对象,通常是 proxy 本身(为啥是通常而不是一定呢，可以看这里 https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/set#%E5%8F%82%E6%95%B0)
  ): boolean {
    //旧属性值
    const oldValue = (target as any)[key]
    //对于ref类型属性赋值只有非浅层模式下才去关心，否则不用去管
    if (!shallow) {
      //如果value是响应式数据，则返回其映射的原始数据
      value = toRaw(value)
      //如果原始对象不是数组,旧属性值是ref对象，新属性值不是ref对象，则将新值赋给旧属性的value，
      //这里也再次间接的说明嵌套在原始数组中的ref是无法解套的
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        //这里会直接return true，表示修改成功，而不让继续往下执行，去触发依赖更新，原因是这个过程会在ref中的set里面触发，因此这里就不用了
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
      //在浅层模式下，对象都按原样设置属性,不去管是否是响应式，
    }

    //判断key值是否存在(原始对象或者原始数组中)
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    // 将本次设置/修改行为，反射到原始对象上(返回值为布尔类型，true表示设置成功)
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    //如果操作的是原型链上的数据,则不做任何触发监听函数的行为。
    //receiver: 最初被调用的对象。通常是 proxy 本身，但 handler 的 set 方法也有可能在原型链上，或以其他方式被间接地调用（因此不一定是 proxy 本身）所以，这里需要通过 target === toRaw(receiver) 就可以判断是否操作的是原型链上的数据。https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/set#%E5%8F%82%E6%95%B0
    //如果此时的赋值操作操作的是原型对象的属性，那就不用去触发依赖更新，首先因为目标对象上没有这个属性，才去的原型链上找，其次 receiver是目标对象，而不是原型对象
    //所以，设置行为还是发生在子对象（目标对象）身上的，原型对象其实没有变化，也就没有必须要触发依赖更新，如果不判断会发现set被触发两次，进而原型上的也会
    //进行一次依赖更新操作，目标对象也会进行一次。
    if (target === toRaw(receiver)) {
      //key如果不存在，则表示是添加属性
      // 否则是给旧属性设置新值
      // trigger 用于通知deps，通知依赖更新(触发依赖更新)
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}
```

同样 set 是由 `createSetter` 方法返回，原因同上。首先获取到旧属性值，然后判断是否是浅层模式，非浅层模式下，目标对象不是数组类型，旧属性值为 Ref 类型，新属性值不是 Ref 类型，则将新属性值赋值给旧属性值的 .value，然后直接 `return true`。这里可以说明两个问题：

- 嵌套在原始数组中的 ref 是无法解套的（!isArray(target) && isRef(oldValue) && !isRef(value)）
- 直接 return true，表示修改成功，而不让继续往下执行，去触发依赖更新，原因是这个过程会在 ref 中的 set 里面触发，因此这里就不用了

然后对传入的 key 存在性判断，下来通过反射将本次设置/修改行为，反射到原始对象上。最后通过判断 target === toRaw(receiver) 是否成立来决定是否触发依赖更新。这时也会有个疑问，为啥要加这个判断呢？目标对象还有跟用 toRaw 方法转换后的代理对象不相等的时候？您别说，还真有，请看下方的截图
[MDN 文档链接在这里](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/set#%E5%8F%82%E6%95%B0)

![](https://github.com/HUYIJUNCODING/vue-next-analysis/blob/master/doc/assets/proxy_set_handler.png)

如果此时的赋值操作操作的是原型对象的属性，那就不用去触发依赖更新，首先因为目标对象上没有这个属性，才去的原型链上找，其次 receiver 是目标对象，而不是原型对象。所以，设置行为还是发生在子对象（目标对象）身上的，原型对象其实没有变化，也就没有必须要触发依赖更新，如果不判断会发生 set 被触发两次，进而原型上的也会进行一次依赖更新操作，目标对象也会进行一次，所以这里的 target === toRaw(receiver) 判断是必要的。

然后判断内部如果 `hadKey` 为 false 表示是添加的新属性，type 为 add，否则表示修改已有属性，type 为 set 然后 trigger 更新依赖，最后一步将 set 结果返回。

reactive 篇我们也不打算对 `track` 和 `trigger` 这两个方法内部进行深入分析，先知道作用就行，下来在 effect 篇详细的介绍。

到这里 baseHandlers 中两个最重要和最常用的 trap 方法就分析结束了，下来对其他几个剩余 trap 也分析下，比较简单，所以直接就贴出来吧。

```js
//删除属性的trap方法
function deleteProperty(target: object, key: string | symbol): boolean {
  //判断目标对象上是否有这个key
  const hadKey = hasOwn(target, key)
  //获取旧的属性值
  const oldValue = (target as any)[key]
  //删除属性操作反射到原始对象上，结果为布尔值，表示执行删除结果
  const result = Reflect.deleteProperty(target, key)
  //如果删除成功，并且key存在，则去触发依赖更新
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  //返回执行删除的结果
  return result
}
//拦截 in 操作符，如果使用 in 操作符操作代理对象（例如： 'a' in p），则该 trap 方法会被触发
function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}
//拦截 Object.keys 方法
function ownKeys(target: object): (string | number | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}
```

这是可读写模式下，那还有几个模式下的 handler（`readonlyHandlers`，`shallowReactiveHandlers`，`shallowReadonlyHandlers`）都是基于 `mutableHandlers` 特殊处理，也比较简单，加上注释一眼就可以看明白的，我们也就直接贴出来吧

```js
//只读模式下代理handler
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet, //readonlyGet 方法会返回getter ，readonlyGet会传递入参true给 getter 的形参isReadonly，标识只读模式，这样，getter 里面会根据此标识惰性访问 readonly将对象类型的属性值
  //用readonly 方法深度处理

  //只读模式不允许设置/修改原始对象的属性值
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  //也不允许删除属性值
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

//浅层模式下的代理handler
//extend 内部调用 Object.assign ，扩展合并对象属性的，会发现该模式下将 mutableHandlers 中的 get ，set 进行了重写，
//其余 trap跟mutableHandlers相同，那为啥要重写这两个trap方法呢，因为模式不一样，劫持逻辑肯定就不一样了，shollow模式下，只会对
//对象根层（第一层）属性进行劫持，因此是可变对象的浅化版（没有解套ref和深层追踪）
export const shallowReactiveHandlers: ProxyHandler<object> = extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
// 浅层只读模式下的代理handler
//只为某个对象的自有（第一层）属性创建浅层的只读响应式代理，同样也不会做深层次、递归地代理，深层次的属性并不是只读的
export const shallowReadonlyHandlers: ProxyHandler<object> = extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
```

好了，以上就是对 `baseHandlers` 中内容的全部分析。还有个表示集合类型代理的 handler `collectionHandlers`，趁热打铁，下来我们就去分析它吧。

#### collectionHandlers

首先从 `mutableCollectionHandlers` 开始，只读模式，浅层模式跟它差不多。

```js
export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  // get trap(捕获器)方法。
  get: createInstrumentationGetter(false, false) //isReadonly: false, shallow: false
}
```

细心的小伙伴肯定会发现集合这里的 handler 跟之前的 baseHandlers 中定义的 handler 不太一样，集合的 handler 只有一个 get 捕获器方法，并没有发现 set,add 等其他捕获方法。这是为什么呢？我们可以尝试写个 demo 看看。

```js
const map = new Map([['a', 1], ['b', 2], ['c', 3]])

const p = new Proxy(map, {
  get(target, key, receiver) {
    return Reflect.get(...arguments)
  }
})

p.set('d', 4)

//TypeError: Method Map.prototype.set called on incompatible receiver [object Object]
```

会发现报错了，咋还报错了呢，写法没毛病啊！其实这里不是你的错，不是我的错，是集合内部设计的问题。这不是你说的，也不是我说的，是人家 [文档](https://javascript.info/proxy#built-in-objects-internal-slots) 说的。截图为证。
![](https://github.com/HUYIJUNCODING/vue-next-analysis/blob/master/doc/assets/proxy_limit.png)
> 大概意思就是集合(`Map`，`Set`，`WeakMap`，`WeakSet`，其实还有 `Date`，`Promise` 等这里不涉及，所以就不讨论)，它们内部都有一个 `internal slots`（内部插槽），是用来存储属性数据的。这些属性数据在访问的时候可以被集合的内置方法直接访问（get,set,has 等），而不通过[[Get]] / [[Set]]内部方法访问它们。因此代理无法拦截。

这里使用代理对象调用集合内置方法的形式去访问，此时代理对象内部并没有 `internal slots` ，但是内置方法 `Map.prototype.set/get`不知道， 会尝试访问内部属性 this.[[MapData]]，此时由于 `this == proxy`，无法在代理中找到它，就报错了，表示访问属性失败。

文档也给出了解决办法。我们就结合我们的例子对照改造下，代码如下：

```js
const map = new Map([['a', 1], ['b', 2], ['c', 3]])

const p = new Proxy(map, {
  get(target, key, receiver) {
    let value = Reflect.get(...arguments)
    return typeof value == 'function' ? value.bind(target) : value
  }
})

p.set('d', 4)
console.log(p.get('d')) //打印结果： 4
```

可以看到代码正常运行，且成功打印设置的属性值，稍作分析，我们就可以看出差别，原来啊，对取到的结果做了一次判断，如果返回值的类型为
函数类型，则手动给绑定 this 执行（target 目标对象）这样，这个方法无论谁调用，内部的 this 永远指向原始的目标集合对象，所以内置方法就可以直接访问
`internal slots`（内部插槽）。那现在大概就明白了为啥集合代理的 handler 只有 get 捕获器方法了吧。那明白了原因后，我们继续看源码, get trap 方法是调用 `createInstrumentationGetter` 方法来初始化的，那我们就去找到这个方法看看内部实现。

```js
//创建不同模式下的 getter 捕获器方法
function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  //一个对象（称为插装对象），内部属性为复写的集合内置方法（会发现跟前面 baseHandlers 中的数组行为类似）
  const instrumentations = shallow
    ? shallowInstrumentations
    : isReadonly
      ? readonlyInstrumentations
      : mutableInstrumentations
  //返回的getter
  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    //如果key为 '__v_isReactive'则返回 !isReadonly，判断代理对象是否是可响应的
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
      //如果key为 '__v_isReadonly',则返回 isReadonly 状态的值,判断代理对象是否是只读的
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
      //如果 key 为 '__v_raw',并且 代理对象的 receiver 在 readonlyMap/reactiveMap 找的到
      //(说明是来获取proxy代理对象的rawObject的),
      //则返回代理对象对应的原始 target 集合对象
    } else if (key === ReactiveFlags.RAW) {
      return target
    }
    // 如果key是`get`、`has`、`add`、`set`、`delete`、`clear`、`forEach`，或者`size`，表示是调用集合的内置方法，则
    //将target 用 instrumentations 替代，否则表示是获取普通属性行为，目标对象还是target然后将获取结果返回（内置方法或者属性值）
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target
        ? instrumentations
        : target,
      key,
      receiver
    )
  }
}
```

会发现 `createInstrumentationGetter` 接收两个参数，分别控制不同模式下的创建，这种方式应该有印象，在 `baseHandlers` 中见过。
然后定义了一个变量来接收不同模式下的 `instrumentations` 对象（称为插装对象），这个插装对象内部属性为复写的集合内置方法（会发现跟前面 baseHandlers 中的数组行为类似），同样我们也拿过来看下（这里我们就只把 `mutableInstrumentations` 拿过来，其他两种模式跟它差不多）

```js
//可变集合handler中的插装对象（属性为复写集合的内置方法，也称为 “插装方法”）
const mutableInstrumentations: Record<string, Function> = {
  //插装方法
  get(this: MapTypes, key: unknown) {
    return get(this, key)
  },
  get size() {
    return size((this as unknown) as IterableCollections)
  },
  has,
  add,
  set,
  delete: deleteEntry,
  clear,
  forEach: createForEach(false, false)
}
```

这个插装对象内部定义了一些操作集合的同名方法，这些方法就是捕获器方法，我们分析完 `createInstrumentationGetter` 会一个个进行分析。
然后 `createInstrumentationGetter` 会返回一个函数，这个函数就是 getter （看参数），当集合调用内置方法或者直接获取自定义属性(自定义属性定义和获取方式同对象)这个函数就会被触发(就是 get 方法)。方法内部先是对 key 是否是 `ReactiveFlags` 里枚举常量标识进行判断,这部分跟 `baseHandler`中逻辑相同，然后返回 `Reflect.get`获取的属性值或者方法。这里稍微说明下：

- 如果 key 是`get`、`has`、`add`、`set`、`delete`、`clear`、`forEach`，或者`size`，表示是调用集合的内置方法，则将 `target` 用 `instrumentations` 替代，否则表示是获取普通属性行为，目标对象还是 `target` 然后将获取结果返回（内置方法或者属性值）

好了，下来对几个插装方法/属性进行分析。

##### get

```js
//插装方法 get,访问集合 internal slots(内置插槽) 中存放的属性
//Map,WeakMap
function get(
  target: MapTypes, //这里需要注意 target 目标对象不是 原始集合对象，而是 它的代理对象
  key: unknown,
  isReadonly = false,
  isShallow = false
) {
  // #1772: readonly(reactive(Map)) should return readonly + reactive version
  // of the value
  //获取代理对象的原始集合对象（这里有可能还是个 reactive 响应式，原因看上面英文备注：readonly(reactive(Map))）
  target = (target as any)[ReactiveFlags.RAW]
  //再转一次，如果 target 不是响应式就原路返回，如果是则拿到他的原始集合对象，这一步会始终可以保证拿到原始集合
  const rawTarget = toRaw(target)
  //集合类型 key 可以是对象类型，因此有可能是响应式的，所以要转一下，保证拿到的是原始类型
  const rawKey = toRaw(key)
  //如果 key 不相等，说明，此时key是响应式的
  if (key !== rawKey) {
    //非只读模式下，进行依赖收集，注意这个时候是收集 key 为响应式对象的依赖
    !isReadonly && track(rawTarget, TrackOpTypes.GET, key)
  }
  //这一步依赖是必须收集的，无论key是否是响应式的，永远收集的是 原始值key对应的依赖
  !isReadonly && track(rawTarget, TrackOpTypes.GET, rawKey)
  //从原型上获取 has方法
  const { has } = getProto(rawTarget)
  //获取不同模式下转换方法。toReadonly(深度追踪对象类型属性，深度只读转换),toReactive(深度追踪对象类型属性，深度响应式转换)，toShallow(浅层转换，会直接返回属性值，不做深度追踪)
  const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
  //执行转换，wrap为根据不同模式，获取到的转换方法
  if (has.call(rawTarget, key)) {
    return wrap(target.get(key))
  } else if (has.call(rawTarget, rawKey)) {
    return wrap(target.get(rawKey))
  }
}
```

首先需要注意参数 `target` ，这里的 target 对象不是原始的集合对象，而是 Proxy 代理对象，为啥是这样呢，下来我们就可以看到他的作用了。
接下来是获取代理对象对应的原始集合对象，在只读模式下，readonly 方法可以对 响应式对象进行处理，所以需要再调用 `toRaw`方法对 target 再转一次，
此时拿到的 `rawTarget` 一定是原生集合对象。除了对集合转换，对于 key 也是需要 `toRaw` 一下的，理由是，集合的 key 可以是对象类型，那就有可能是响应式的，所以也需要转一下拿到原始值。此时我们就名白了传入的代理对象，经过 toRaw 后可以拿到 其对应的原始集合，这样就解决了代理内部因没有 `internal slots`（内部插槽）访问报错的问题了。实在是太机制了，哈哈哈！然后进行依赖收集，最后根据不同模式，拿到对应的响应式转换方法，对对象类型的属性值进行惰性响应式处理（这里跟 baseHandler 里的 get 方法类似），这里提一个小点，还记得我们之前在 `baseHandler` 的 get 方法最后看到的 `ref` 解套吗？当时说 `从 Array 或者 Map 等原生集合类中访问 ref 时，不会自动解套` ，你看这里就体现了这句话，我们并没有看到有关 `ref`的解套处理逻辑。

##### size

```js
//插装方法 size,获取集合长度
//all Collection
function size(target: IterableCollections, isReadonly = false) {
  //获取到原始集合对象
  target = (target as any)[ReactiveFlags.RAW]
  //非只读模式下去收集依赖(这里是依赖收集track而不是trigger，因为size是一个获取属性)
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
  //这里 size 因为是属性，不是方法，所以通过Reflect.get获取
  return Reflect.get(target, 'size', target)
}
```

##### has

```js
//插装方法 has,查询 key 是否存在于集合中，
//all Collection
//tip: 会发现参数列表第一个参数为 this,但是又会发现调用的地方并没有传 this，怎么回事呢，这是 ts 的语法特性，
//在 ts 里是假的参数，放在第一位，用来指定函数中 this 的类型,调用的地方是不需要传这个参数的，后面方法也是相同情况。
function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
const target = (this as any)[ReactiveFlags.RAW]
const rawTarget = toRaw(target)
const rawKey = toRaw(key)
//属于查询方法，因此会执行依赖收集，触发 track 方法。
if (key !== rawKey) {
!isReadonly && track(rawTarget, TrackOpTypes.HAS, key)
}
!isReadonly && track(rawTarget, TrackOpTypes.HAS, rawKey)
return key === rawKey
? target.has(key)
: target.has(key) || target.has(rawKey)
}
```

`size` 属性 和 `has` 方法逻辑也比较简单，就放到一起说了，首先 `size` 是个获取集合长度的插装属性，`has` 是个查询 `key` 是否存在于集合中的查询方法，都属于查询类，因此内部都会调用 `track`进行依赖收集，其次它们的入参 `target` 是个代理对象，因此内部需要 `toRaw` 一下，拿到原始集合对象，然后调用内部方法/属性访问内置属性

##### add

```js
//插装方法 add,往集合 internal slots(内置插槽) 中存属性值
//set ,MapSet
function add(this: SetTypes, value: unknown) {
  //add是操作 set集合 的存值方法，value直接就是要存的属性值。
  //获取原始数据
  value = toRaw(value)
  //获取原始集合对象（这里的this是原始目标集合的proxy代理对象）
  const target = toRaw(this)
  //获取原型
  const proto = getProto(target)
  //调用原型上的 has 方法判断 value是否已经存在，返回布尔值
  const hadKey = proto.has.call(target, value)
  //添加属性
  const result = target.add(value)
  //如果不存在，说明是新值，则去触发依赖更新，否则不去触发，因为重新赋的是已经存在的属性值的。
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  //返回添加属性值后的 Set 结构本身
  return result
}
```

`add` 是捕获劫持 `set` 集合添加属性的方法。`this` 含义同上,首先拿到原始 value 和原始集合对象，再获取原型方法，接下里通过 .add 添加属性进集合中，
最后调用 `trigger` 触发依赖更新。

##### set

```js
//插装方法 set,往Map集合 internal slots(内置插槽) 中设置属性/修改 [key,value]
//Map ,WeakMap
function set(this: MapTypes, key: unknown, value: unknown) {
  //获取原始数据
  value = toRaw(value)
  //获取原始集合对象（这里的this是原始目标集合的proxy代理对象）
  const target = toRaw(this)
  //获取 has,get原型方法
  const { has, get } = getProto(target)
  //判断key是否已经存在
  let hadKey = has.call(target, key)
  //不存在，对 key 进行 toRaw转换后再判断（key，可以是对象，因此有可能是一个proxy代理对象）
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }
  //获取旧属性值，以及存入新属性值
  const oldValue = get.call(target, key)
  const result = target.set(key, value)
  //触发依赖更新
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) {
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return result
}
```

`set` 与 `get`相对应，都是用来操作 `Map`集合的方法，`set` 的原理跟 `add` 差不多，注释也比较详细，就不多啰嗦了。

##### delete

```js
//插装方法 delete,删除Map/set集合 internal slots(内置插槽) 中的属性
//Map ,WeakMap，Set,WeakSet
function deleteEntry(this: CollectionTypes, key: unknown) {
  const target = toRaw(this)
  const { has, get } = getProto(target)
  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }
  //这里对 get 进行存在性判断原因是，对于set集合，get方法是不存在的。
  const oldValue = get ? get.call(target, key) : undefined
  // forward the operation before queueing reactions
  //在去更新依赖之前先执行删除操作
  const result = target.delete(key)
  //去触发依赖更新，类型为 delete，会更新依赖的值为 undefined
  if (hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}
```

##### clear

```js
//插装方法 clear,清空Map/set集合 internal slots(内置插槽)
//Map,Set(WeakSet,WeakMap 没有此方法)
function clear(this: IterableCollections) {
  const target = toRaw(this)
  const hadItems = target.size !== 0
  const oldTarget = __DEV__
    ? isMap(target)
      ? new Map(target)
      : new Set(target)
    : undefined
  // forward the operation before queueing reactions
  const result = target.clear()
  if (hadItems) {
    trigger(target, TriggerOpTypes.CLEAR, undefined, undefined, oldTarget)
  }
  return result
}
```

`deleteEntry` 内部会调用 `delete` 是删除 Map/set 集合 internal slots(内置插槽) 中的属性时会触发的捕获器函数，最后触发依赖更新的时候会将
依赖的值更新为 `undefined`。

`clear` 只能用户 `Set` ，`Map` 集合清空内置插槽时触发，不能用于 `WeakSet`，`WeakMap` ，该方法触发会更新整个集合的依赖。


##### forEach

```js
//插装迭代器方法forEach
//Set Map
function createForEach(isReadonly: boolean, isShallow: boolean) {
  return function forEach(
    this: IterableCollections,
    callback: Function,
    thisArg?: unknown //可以显式指定this，默认为集合对象本身。
  ) {
    const observed = this as any //迭代对象，一般为集合的代理对象
    const target = observed[ReactiveFlags.RAW] //获取到代理对象对应的原始集合对象，因为有可能是个reative，下面会再toRaw一下
    const rawTarget = toRaw(target) //真正的原始集合对象
    //不同模式下的转化方法
    const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
    //非只读模式下依赖收集（遍历就是查询操作）
    !isReadonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
    //执行遍历
    return target.forEach((value: unknown, key: unknown) => {
      // important: make sure the callback is
      // 1. invoked with the reactive map as `this` and 3rd arg
      // 2. the value received should be a corresponding reactive/readonly.
      //执行 callback 回调
      //thisArg是传入的callback方法的调用者，可以显式指定，默认为传入的集合代理对象
      //这里会使用 wrap 函数会对key,value 进行响应式转换，原因是 forEach方法只能被原始集合调用，不能被代理调用，
      //那遍历得到的 value,key是原始值，失去了响应性，因此需要再次处理来恢复响应性。
      return callback.call(thisArg, wrap(value), wrap(key), observed)
    })
  }
}
```
`createForEach` 方法会返回一个迭代器方法 `forEach` 。当遍历集合的时候会触发该捕获器方法。该方法可以显式指定 `callback` 回调的调用者 `this`,
迭代属于查询，因为内部会触发 `track` 收集依赖。最后调用 `callback` 的时候 会对 value, key 进行响应式处理，使其恢复响应式。

到这里关于  `mutableInstrumentations` 插装对象中的几个 `插装方法`就分析完了，这是 `mutableCollectionHandlers` 下的，对于 `shallowCollectionHandlers` 和 `readonlyCollectionHandlers` 都是它的特殊处理版本，基本一致，我们就不去费分析了，稍稍看下就明白了。

最后还有一个 `iteratorMethods` ,也是迭代器相关的方法，建议还是直接看源码吧，也就不多哔哔了（其实是怕哔哔不出来，说不清，道不明，哈哈哈）。

至此，关于 `reactive` 章节的源码内容就分析完了。有没有感觉很爽的样子，哈哈哈。下一章我们就分析千呼万唤使都使不出来，终于要出来了的 effect,相信一定会刺激的飞起。
