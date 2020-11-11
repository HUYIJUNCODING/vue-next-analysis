## reactive 源码分析

### 前言

- reactive 是 vue3.0 中实现响应式系统最重要的方法之一，它接收一个普通对象然后返回该普通对象的响应式代理。
- 该响应式转换是“深层的”：会影响对象内部所有嵌套的属性，基于 ES6 的 Proxy 实现(Proxy 其实也是不支持嵌套代理，因此深层代理，也是递归出来的)。
- Proxy 是 reactive 内部的实现基础，她是直接代理整个对象，相较于 vue2.x 中的 Object.defineProperty 劫持对象的指定属性会显得格外省事和强大(毕竟拥有 13 种拦截方法，能力不是吹出来的)
- reactive 返回的代理对象不等于原始对象。建议仅使用代理对象而避免依赖原始对象(直接对原始对象进行读写操作，不会触发依赖更新和收集)

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

- get

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

例如这里我们写个 push 方法的 demo ,然后浏览器打开，启动 debugger 调试，会发现先触发两次 get ,然后触发两次 set。虽然知道了结果，但是又引出一个问题，这个触发两次 get 然后再触发两次 set 是框架层面控制还是 Proxy 代理本身控制的，然后就又写了个比较单纯的 demo。

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

- 1.`includes`, `indexOf`, `lastIndexOf` 只是查询，不涉及到修改，因此只会触发 get 劫持，
- 2.`push`,`pop` 这两个方法先会触发两次 get(获取方法一次，获取 length 一次),pop 弹出，下来会执行一次获取最后一个元素，然后执行弹出，此时 length 改变，所以需要最后触发一次 set 劫持。push 因为是推入元素，先给索引下标赋一次值触发一次 set 劫持，接着 length 改变，会再触发一次 set 劫持。
- 3.`shift`，`unshift`,`splice` 同样 也会先触发两次 get(获取方法一次，获取 length 一次)，然后都可以修改数组，因此会触发 set ，不过这几个方法有点意思，一般执行的过程中会先 get ，然后 set，我想 get 应该是为了定位目标去查找触发的，set 是设置值时候触发的,过程中会触发多次 set，因此这个在源码中会多次触发 `trigger`,其实想一想也合理，`shift`，`unshift`,`splice` 这样的方法会影响数组原来索引对应的 value 值，那原来索引对应的值变了，
     依赖也应该去被更新以保持永远同步最新值，但是就是觉得 set 太过于频繁，是否会有性能上的开销。这里还有一个点，就是这些修改方法，最后都会触发 length 改变引起的 set 劫持，但是实际上发现，对于 `push` 方法 执行 length 触发的 set 逻辑时，获取的旧 length 已经是新的值了，由于 `value === oldValue`，这次并不会触发 `trigger`。而对于 其余几个修改方法，最后的 length 触发的 set 时候 `value ！== oldValue` 会触发一次 `trigger`。

这些操作方法的差异化应该是数组本身底层的规范所导致的，感觉比较复杂，不知道其底层的原因也不影响源码的分析，所以就不去深究了，太复杂了。回到开始的疑问，原来这些修改数组的方法背后是通过 触发 get 和 set 方法从而进行依赖收集和更新的，难怪不需要显示的定义对应的 trap 劫持方法。而且这是 Proxy 本身的特，并不是框架层所做的，顿时觉得，Proxy 真的是太强大了，哈哈哈!

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

- set

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

- 1.嵌套在原始数组中的 ref 是无法解套的（!isArray(target) && isRef(oldValue) && !isRef(value)）
- 2.直接 return true，表示修改成功，而不让继续往下执行，去触发依赖更新，原因是这个过程会在 ref 中的 set 里面触发，因此这里就不用了


然后对传入的 key 存在性判断，下来通过反射将本次设置/修改行为，反射到原始对象上。最后通过判断 target === toRaw(receiver) 是否成立来决定是否触发依赖更新。这时也会有个疑问，为啥要加这个判断呢？目标对象还有跟用 toRaw 方法转换后的代理对象不相等的时候？您别说，还真有，请看下方的截图

