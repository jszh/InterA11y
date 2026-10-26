package intera11y.research;

import com.fasterxml.jackson.databind.ObjectMapper;
import edu.usc.ContextTree.ContextTree;
import edu.usc.ContextTree.FunctionalArea;
import edu.usc.ContextTree.Construction.ConstructContextTree;
import edu.usc.ContextTree.Construction.AffinityCalculation.GetAttributeData;
import edu.usc.KFG.KFFG.KFFG;
import edu.usc.KFG.KFFG.KFFGEdge;
import edu.usc.KFG.KFFG.KFFGNode;
import edu.usc.KFG.UIGraph.UIGraphEdge;
import edu.usc.KFG.UIGraph.UIGraphNode;
import edu.usc.KFG.UIGraph.UIGraphState;
import edu.usc.Utilities.LoadConfig;
import org.openqa.selenium.By;
import org.openqa.selenium.Dimension;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.Keys;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.interactions.Actions;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static edu.usc.Detection.DetectionHeuristics.DetectFailures.FindFailures;
import static edu.usc.Detection.RunDetection.Detect;
import static edu.usc.Detection.RunDetection.SaveDetectedFailures;

/** An acquisition/CLI adapter. C-Tree grouping and LNF heuristics are upstream classes. */
public final class PortableLynx {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static class CollectedTree extends ConstructContextTree {
        final Set<FunctionalArea> leaves;
        CollectedTree(Set<FunctionalArea> leaves) { this.leaves = leaves; }
        @Override public void InitializeWorkSet(Set workSet, LoadConfig config, String subject) {
            workSet.addAll(leaves);
        }
    }

    private static class ObservedGraph extends UIGraphState {
        final List<UIGraphEdge> order;
        ObservedGraph(List<UIGraphEdge> order) { super("KFFG"); this.order=order; }
        @Override public List<UIGraphEdge> getOrder() { return order; }
    }

    private static Map<String, String> parse(String[] args) {
        Map<String, String> result = new HashMap<>();
        for (int i = 0; i < args.length; i += 2) {
            if (i + 1 >= args.length || !args[i].startsWith("--")) {
                throw new IllegalArgumentException("Expected --name value arguments");
            }
            result.put(args[i].substring(2), args[i + 1]);
        }
        return result;
    }

    /** Root-relative addresses keep frame/shadow contexts explicit and namespace safe. */
    private static final String DOM = """
        const resolutions=[];
        const norm=s=>String(s||'').replace(/\\s+/g,' ').trim();
        function address(e, kind='element') {
          const parts=[];
          for(let n=e;n&&n.nodeType===1;n=n.parentElement){let i=1;
            for(let s=n.previousElementSibling;s;s=s.previousElementSibling)
              if(s.localName===n.localName&&s.namespaceURI===n.namespaceURI)i++;
            parts.unshift({name:n.localName,namespace:n.namespaceURI,index:i});}
          const xpath='/'+parts.map(p=>(p.namespace==='http://www.w3.org/1999/xhtml'?p.name:
            "*[local-name()='"+p.name+"' and namespace-uri()='"+p.namespace+"']")+'['+p.index+']').join('/');
          const root=e.getRootNode();
          return [...(root.host?address(root.host,'shadow'):[]),{kind,xpath,parts,
            identity:{tag:e.localName,id:e.getAttribute('id'),name:e.getAttribute('name'),href:e.getAttribute('href'),
              ariaLabel:e.getAttribute('aria-label'),title:e.getAttribute('title'),text:norm(e.innerText||e.textContent).slice(0,256)}}];
        }
        function resolve(steps){let root=document,e=null;
          for(const step of steps){let parent=root;
            for(const p of step.parts){const a=[...(parent.children||[])].filter(n=>n.localName===p.name&&n.namespaceURI===p.namespace);
              parent=a[p.index-1];if(!parent)break;}
            e=parent;const f=step.identity;let method='structural-path';
            if(f){
              const namespace=step.parts[step.parts.length-1].namespace;
              const all=[...root.querySelectorAll('*')].filter(n=>n.localName===f.tag&&n.namespaceURI===namespace);
              const byId=f.id?all.filter(n=>n.id===f.id):[];
              const attr={name:'name',href:'href',ariaLabel:'aria-label',title:'title'};
              const keys=Object.keys(attr).filter(k=>f[k]!==null&&f[k]!==undefined&&f[k]!=='');
              const fingerprint=n=>keys.every(k=>n.getAttribute(attr[k])===f[k])&&(!f.text||norm(n.innerText||n.textContent).slice(0,256)===f.text);
              if(byId.length===1){e=byId[0];method='unique-id';}
              else if(e&&e.localName===f.tag&&(!f.id||e.id===f.id)&&fingerprint(e)){}
              else if(keys.length||f.text){
                const found=all.filter(fingerprint);
                if(found.length!==1)return null;e=found[0];method='unique-fingerprint';
              }else return null;
            }
            if(!e)return null;
            resolutions.push({kind:step.kind,method,resolved:address(e).map(s=>s.xpath).join(' >> ')});
            if(step.kind==='shadow'){root=e.shadowRoot;if(!root)return null;}}
          return e;
        }
        function deepActive(){let e=document.activeElement;
          while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;
          if(!e||e===document.body||e===document.documentElement)return null;
          return {element:e,steps:address(e),tag:e.localName,type:e.getAttribute('type')||''};
        }
        function inventory(root=document){let count=0,roots=0;
          for(const e of root.querySelectorAll('*')){
            const s=getComputedStyle(e),r=e.getBoundingClientRect();
            if(e.tabIndex>=0&&!e.disabled&&!e.closest('[inert]')&&s.visibility!=='hidden'&&s.display!=='none'&&r.width>0&&r.height>0)count++;
            if(e.shadowRoot){const sub=inventory(e.shadowRoot);count+=sub.count;roots+=1+sub.openShadowRoots;}}
          return {count,openShadowRoots:roots};}
        """;

    private static String path(List<Map<String,Object>> steps) {
        StringBuilder out=new StringBuilder();
        for(Map<String,Object> step:steps){out.append(step.get("xpath"));
            if(!step.get("kind").equals("element"))out.append(" >>").append(step.get("kind")).append(">> ");}
        return out.toString();
    }

    @SuppressWarnings("unchecked")
    private static Map<String,Object> active(ChromeDriver driver) {
        driver.switchTo().defaultContent();
        List<Map<String,Object>> prefix=new ArrayList<>();
        Map<String,Object> fallback=null;
        for(int depth=0;depth<32;depth++){
            Map<String,Object> found=(Map<String,Object>)driver.executeScript(DOM+"return deepActive();");
            if(found==null)return fallback;
            List<Map<String,Object>> own=(List<Map<String,Object>>)found.get("steps");
            List<Map<String,Object>> steps=new ArrayList<>(prefix);steps.addAll(own);
            found.put("steps",steps);found.put("xpath",path(steps));
            String tag=(String)found.get("tag");
            if(!tag.equals("iframe")&&!tag.equals("frame"))return found;
            // An empty frame can itself be the native focus stop; keep its host as fallback.
            fallback=new LinkedHashMap<>(found);
            List<Map<String,Object>> next=new ArrayList<>(prefix);
            for(int i=0;i<own.size();i++){
                Map<String,Object> step=new LinkedHashMap<>(own.get(i));
                if(i==own.size()-1)step.put("kind","frame");next.add(step);}
            driver.switchTo().frame((WebElement)found.get("element"));prefix=next;
        }
        throw new IllegalStateException("Frame nesting exceeds the recorded 32-context guard");
    }

    private static final class Resolved {
        WebElement element;double x=0,y=0,sx=1,sy=1;
        String background="rgba(0, 0, 0, 0)";
        final List<Map<String,Object>> resolutions=new ArrayList<>();
    }

    private static Resolved awaitResolved(ChromeDriver driver,List<Map<String,Object>> steps) throws Exception {
        long deadline=System.nanoTime()+Duration.ofSeconds(15).toNanos();
        RuntimeException last=null;
        while(System.nanoTime()<deadline){
            try{return resolve(driver,steps);}catch(org.openqa.selenium.NotFoundException | org.openqa.selenium.StaleElementReferenceException | IllegalStateException error){last=error;Thread.sleep(200);}
        }
        throw new IllegalStateException("Observed target did not return with the same identity after reload: "+path(steps),last);
    }

    @SuppressWarnings("unchecked")
    private static Resolved resolve(ChromeDriver driver,List<Map<String,Object>> steps){
        driver.switchTo().defaultContent();Resolved result=new Resolved();
        List<Map<String,Object>> group=new ArrayList<>();
        for(Map<String,Object> step:steps){
            group.add(step);
            if(step.get("kind").equals("shadow"))continue;
            Map<String,Object> answer=(Map<String,Object>)driver.executeScript(DOM+"const element=resolve(arguments[0]);return {element,resolutions};",group);
            WebElement e=(WebElement)answer.get("element");
            result.resolutions.addAll((List<Map<String,Object>>)answer.get("resolutions"));
            if(e==null)throw new IllegalStateException("Observed element unavailable after reload: "+path(steps));
            if(step.get("kind").equals("element")){result.element=e;return result;}
            Map<String,Object> f=(Map<String,Object>)driver.executeScript("""
                const e=arguments[0],r=e.getBoundingClientRect();
                const sx=e.offsetWidth?r.width/e.offsetWidth:1,sy=e.offsetHeight?r.height/e.offsetHeight:1;
                return {x:r.x+scrollX+e.clientLeft*sx,y:r.y+scrollY+e.clientTop*sy,sx,sy};
                """,e);
            String background=new ComposedAttributes(driver,result.background).backgroundIncluding(e);
            driver.switchTo().frame(e);
            List<Number> scroll=(List<Number>)driver.executeScript("return [scrollX,scrollY];");
            double sx=((Number)f.get("sx")).doubleValue(),sy=((Number)f.get("sy")).doubleValue();
            result.x+=result.sx*(((Number)f.get("x")).doubleValue()-scroll.get(0).doubleValue()*sx);
            result.y+=result.sy*(((Number)f.get("y")).doubleValue()-scroll.get(1).doubleValue()*sy);
            result.sx*=sx;result.sy*=sy;result.background=background;group.clear();
        }
        throw new IllegalStateException("Locator has no terminal element: "+path(steps));
    }

    /** Preserve upstream feature definitions while crossing composed ancestry. */
    private static final class ComposedAttributes extends GetAttributeData {
        final ChromeDriver driver;final String fallback;
        ComposedAttributes(ChromeDriver driver,String fallback){this.driver=driver;this.fallback=fallback;}
        String backgroundIncluding(WebElement e){
            while(e!=null){String color=e.getCssValue("background-color");
                if(!color.equals("rgba(0, 0, 0, 0)")&&!color.equals("transparent"))return color;
                e=(WebElement)driver.executeScript("return arguments[0].parentElement||arguments[0].getRootNode().host||null;",e);}
            return fallback;
        }
        @Override public String GetBackgroundColor(WebElement body,WebElement e){
            if(e.equals(body))return fallback;
            WebElement parent=(WebElement)driver.executeScript("return arguments[0].parentElement||arguments[0].getRootNode().host||null;",e);
            return backgroundIncluding(parent);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String,Object> ready(ChromeDriver driver,int settle) throws Exception {
        long deadline=System.nanoTime()+Duration.ofSeconds(15).toNanos();
        long unchanged=System.nanoTime();String previous="";Map<String,Object> state=new LinkedHashMap<>();
        while(System.nanoTime()<deadline){
            state=(Map<String,Object>)driver.executeScript(DOM+"return {state:document.readyState,body:!!document.body,...inventory(),elements:document.getElementsByTagName('*').length,pendingStyles:[...document.querySelectorAll('link[rel=stylesheet]')].filter(e=>!e.disabled&&!e.sheet).length};");
            String fingerprint=state.toString();
            if(!fingerprint.equals(previous)){previous=fingerprint;unchanged=System.nanoTime();}
            if(Boolean.TRUE.equals(state.get("body"))&&!state.get("state").equals("loading")
                    &&System.nanoTime()-unchanged>=Duration.ofMillis(Math.max(1000,settle)).toNanos())break;
            Thread.sleep(200);
        }
        driver.executeCdpCommand("Page.bringToFront",Map.of());
        driver.executeScript("window.focus();");
        state.put("documentHasFocus",driver.executeScript("return document.hasFocus();"));
        state.put("waitBudgetMs",15000);return state;
    }

    private static void navigate(ChromeDriver driver,String url,Map<String,Object> acquisition,int settle) throws Exception {
        driver.switchTo().defaultContent();
        try{driver.get(url);}catch(org.openqa.selenium.TimeoutException timeout){
            // A responsive DOM can be usable even when an external load never completes.
            Object state=driver.executeScript("return document.readyState;");
            if(!"interactive".equals(state)&&!"complete".equals(state))throw timeout;
            acquisition.put("navigationWarning",timeout.toString());
        }
        acquisition.put("readiness",ready(driver,settle));
    }

    @SuppressWarnings("unchecked")
    private static void diagnoseEmptyReplay(ChromeDriver driver,String url,Map<String,Object> acquisition,int settle) throws Exception {
        acquisition.put("emptyRuntimeDocument",driver.executeScript(DOM+"return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,1500),...inventory()};"));
        if(!url.startsWith("file:"))return;
        String original=driver.getWindowHandle();boolean opened=false;
        try{
            driver.switchTo().newWindow(org.openqa.selenium.WindowType.TAB);opened=true;
            driver.executeCdpCommand("Emulation.setScriptExecutionDisabled",Map.of("value",true));
            driver.get(url);ready(driver,settle);
            Map<String,Object> saved=(Map<String,Object>)driver.executeScript(DOM+"return {url:location.href,title:document.title,...inventory()};");
            acquisition.put("staticReplayDiagnostic",saved);
            if(((Number)saved.get("count")).intValue()>0){
                acquisition.put("complete",false);acquisition.put("fullDocumentTraversal",false);
                acquisition.put("termination","saved-page-script-collapse");
                acquisition.put("unavailableReason","Live saved-page scripts removed the observable controls present in the static replay; no script-disabled keyboard verdict substituted.");
            }
        }catch(Exception diagnosticError){acquisition.put("staticReplayDiagnosticError",diagnosticError.toString());
            acquisition.put("complete",false);acquisition.put("fullDocumentTraversal",false);
            acquisition.put("unavailableReason","The empty runtime graph could not be verified against the saved document.");
        }finally{if(opened)driver.close();driver.switchTo().window(original);}
    }

    @SuppressWarnings("unchecked")
    private static final class FeatureSnapshot {
        Resolved resolved;ArrayList data;HashSet<String> css;String tag,text;int attempts;
    }

    private static FeatureSnapshot featureSnapshot(ChromeDriver driver,List<Map<String,Object>> steps) throws Exception {
        long deadline=System.nanoTime()+Duration.ofSeconds(15).toNanos();int attempts=0;
        while(true){
            attempts++;
            try{
                Resolved resolved=awaitResolved(driver,steps);WebElement e=resolved.element;
                // Keep native rendered-text semantics, then read all remaining live fields
                // synchronously so a component replacement cannot split the snapshot.
                String renderedText=e.getText();
                org.openqa.selenium.Rectangle nativeRect=e.getRect();
                Map<String,Object> raw=(Map<String,Object>)driver.executeScript("""
                    const e=arguments[0],r=e.getBoundingClientRect(),o=getComputedStyle(e);
                    const attrs={};for(const k of ['id','name','class','role','value']){
                      const v=k==='class'?e.getAttribute('class'):e[k];attrs[k]=typeof v==='string'?v:e.getAttribute(k);}
                    let css='';for(let i=0;i<o.length;i++)css+=o[i]+':'+o.getPropertyValue(o[i])+';';
                    let p=e.parentElement||e.getRootNode().host,color=arguments[1];
                    while(p){const c=getComputedStyle(p).backgroundColor;
                      if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent'){color=c;break;}
                      p=p.parentElement||p.getRootNode().host;}
                    return {attrs,css,background:color,tag:e.localName,x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};
                    """,e,resolved.background);
                Map<String,String> attrs=(Map<String,String>)raw.get("attrs");
                int x=nativeRect.getX(),y=nativeRect.getY();
                int width=nativeRect.getWidth(),height=nativeRect.getHeight();
                String background=(String)raw.get("background");
                try{background=org.openqa.selenium.support.Color.fromString(background).asRgba();}catch(IllegalArgumentException unsupported){}
                final String capturedBackground=background;
                WebElement frozen=(WebElement)java.lang.reflect.Proxy.newProxyInstance(WebElement.class.getClassLoader(),new Class<?>[]{WebElement.class},(proxy,method,args)->{
                    switch(method.getName()){
                        case "getAttribute":return attrs.get((String)args[0]);
                        case "getText":return renderedText;
                        case "getTagName":return raw.get("tag");
                        case "getLocation":return new org.openqa.selenium.Point(x,y);
                        case "getSize":return new Dimension(width,height);
                        case "getRect":return new org.openqa.selenium.Rectangle(new org.openqa.selenium.Point(x,y),new Dimension(width,height));
                        case "equals":return proxy==args[0];
                        case "hashCode":return System.identityHashCode(proxy);
                        case "toString":return "Captured focus target "+path(steps);
                        default:throw new UnsupportedOperationException("Upstream requested uncaptured field: "+method.getName());
                    }
                });
                GetAttributeData extractor=new GetAttributeData(){
                    @Override public String GetBackgroundColor(WebElement body,WebElement target){return capturedBackground;}
                };
                FeatureSnapshot snapshot=new FeatureSnapshot();snapshot.resolved=resolved;
                snapshot.data=extractor.AttributeData(driver,frozen);
                snapshot.css=new HashSet<>(java.util.Arrays.asList(((String)raw.get("css")).split(";")));
                snapshot.tag=(String)raw.get("tag");snapshot.text=renderedText;snapshot.attempts=attempts;
                return snapshot;
            }catch(org.openqa.selenium.StaleElementReferenceException | org.openqa.selenium.NotFoundException error){
                if(System.nanoTime()>=deadline)throw error;
                Thread.sleep(200);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Set<FunctionalArea> collectFeatures(ChromeDriver driver,List<String> order,
            Map<String,List<Map<String,Object>>> locators,List<Map<String,Object>> nodes) throws Exception {
        Set<FunctionalArea> leaves=new HashSet<>();int index=0;
        for(String id:order){
            FeatureSnapshot snapshot=featureSnapshot(driver,locators.get(id));Resolved resolved=snapshot.resolved;
            ArrayList data=snapshot.data;
            List<Integer> local=(List<Integer>)data.get(3);
            List<Integer> box=new ArrayList<>(List.of((int)Math.round(resolved.x+resolved.sx*local.get(0)),
                (int)Math.round(resolved.y+resolved.sy*local.get(1)),(int)Math.round(resolved.x+resolved.sx*local.get(2)),
                (int)Math.round(resolved.y+resolved.sy*local.get(3))));
            List<Double> center=new ArrayList<>(List.of((double)((box.get(0)+box.get(2))/2),(double)((box.get(1)+box.get(3))/2)));
            FunctionalArea area=new FunctionalArea(Integer.toString(++index),id,"",box);area.setCentroid(center);
            Map<String,String> theme=new HashMap<>();theme.put("id",(String)data.get(0));theme.put("name",(String)data.get(1));theme.put("text",(String)data.get(2));
            area.setThematic_info(theme);area.setAllThematic_info((String)data.get(5));area.setBackgroundColor((String)data.get(6));
            area.setApplied_css(snapshot.css);leaves.add(area);
            Map<String,Object> node=new LinkedHashMap<>();node.put("xpath",id);node.put("index",index);node.put("tag",snapshot.tag);node.put("text",snapshot.text);
            node.put("MBR",box);node.put("centroid",center);node.put("rect",Map.of("x",box.get(0),"y",box.get(1),"width",box.get(2)-box.get(0),"height",box.get(3)-box.get(1)));
            node.put("thematic",theme);node.put("allThematic",area.getAllThematic_info());node.put("backgroundColor",area.getBackgroundColor());
            node.put("cssBeforeFilter",new ArrayList<>(area.getApplied_css()));node.put("locator",locators.get(id));
            node.put("locatorResolution",resolved.resolutions);node.put("featureAttempts",snapshot.attempts);
            node.put("coordinateTransform",Map.of("x",resolved.x,"y",resolved.y,"sx",resolved.sx,"sy",resolved.sy));nodes.add(node);
        }
        new GetAttributeData().FilterCSS(leaves);
        for(FunctionalArea area:leaves)for(Map<String,Object> node:nodes)if(node.get("xpath").equals(area.getXpath()))node.put("cssAfterFilter",new ArrayList<>(area.getApplied_css()));
        return leaves;
    }

    private static UIGraphState makeGraph(List<String> order, Set<FunctionalArea> leaves, List<Map<String,Object>> observedEdges) {
        Map<String, KFFGNode> byPath = new LinkedHashMap<>();
        for (FunctionalArea area : leaves) {
            KFFGNode node = new KFFGNode(area.getXpath());
            node.setX(area.getMBR().get(0)); node.setY(area.getMBR().get(1));
            node.setWidth(area.getMBR().get(2) - node.getX());
            node.setHeight(area.getMBR().get(3) - node.getY());
            byPath.put(area.getXpath(), node);
        }
        Set<UIGraphEdge> edges = new HashSet<>();
        List<UIGraphEdge> orderedEdges=new ArrayList<>();
        for(Map<String,Object> observed:observedEdges){
            UIGraphEdge edge=new KFFGEdge(byPath.get(observed.get("source")),byPath.get(observed.get("target")),"TAB");
            edges.add(edge);orderedEdges.add(edge);
        }
        KFFG graph = new KFFG();graph.setNodes(new HashSet<UIGraphNode>(byPath.values()));graph.setEdges(edges);
        UIGraphState state=new ObservedGraph(orderedEdges);state.setUigraph(graph);
        state.setV_entry(byPath.get(order.get(0)));state.setV_exit(byPath.get(order.get(order.size()-1)));
        for(int i=0;i<order.size();i++)byPath.get(order.get(i)).setOrder(i+1);
        return state;
    }

    private static ContextTree makeTree(LoadConfig config, String subject, Set<FunctionalArea> leaves)
            throws Exception {
        FunctionalArea root = new CollectedTree(leaves).Construct(config, subject);
        Set<FunctionalArea> vertices = new HashSet<>();
        List<FunctionalArea> pending = new ArrayList<>(); pending.add(root);
        while (!pending.isEmpty()) {
            FunctionalArea area = pending.remove(pending.size() - 1);
            vertices.add(area); pending.addAll(area.getChildren());
        }
        ContextTree tree = new ContextTree();
        tree.setRoot(root); tree.setVertex_set(vertices);
        tree.Save(config, subject);
        return tree;
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> options = parse(args);
        String subject = options.getOrDefault("subject", "page");
        Path output = Path.of(options.getOrDefault("output", ".")).toAbsolutePath();
        Files.createDirectories(output);
        LoadConfig config = new LoadConfig();
        if (options.getOrDefault("mode", "url").equals("detect")) {
            Detect(config, subject);
            return;
        }
        String url = options.get("url");
        if (url == null) throw new IllegalArgumentException("--url is required");
        int settle = Integer.parseInt(options.getOrDefault("settle-ms", "10000"));
        int cap = Integer.parseInt(options.getOrDefault("max-tabs", "2000"));
        ChromeOptions chrome = new ChromeOptions();
        chrome.setPageLoadStrategy(org.openqa.selenium.PageLoadStrategy.EAGER);
        chrome.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
                            "--disable-extensions", "--ignore-certificate-errors");
        String binary = options.get("chrome-binary");
        if (binary != null) chrome.setBinary(binary);
        ChromeDriver driver = new ChromeDriver(chrome);
        List<String> order = new ArrayList<>();
        List<Map<String, Object>> nodes = new ArrayList<>();
        List<Map<String, Object>> actions = new ArrayList<>();
        Map<String, Object> acquisition = new LinkedHashMap<>();
        acquisition.put("schema", "intera11y-lynx-acquisition-v1");
        acquisition.put("url", url);
        acquisition.put("complete", false);
        acquisition.put("adapter", "Fresh Selenium TAB acquisition; upstream C-Tree and detectors unchanged");
        acquisition.put("parameters", Map.of("maxTabs", cap, "settleMs", settle,
                                             "chromeOptions", chrome.asMap()));
        Map<String,List<Map<String,Object>>> locators=new LinkedHashMap<>();
        List<Map<String,Object>> graphEdges=new ArrayList<>();
        acquisition.put("schema","intera11y-lynx-acquisition-v2");
        acquisition.put("actions",actions);acquisition.put("order",order);acquisition.put("nodes",nodes);
        acquisition.put("locators",locators);acquisition.put("edges",graphEdges);
        acquisition.put("coveragePolicy","Native TAB first-discovery graph across frames and open shadow roots; cycles and unresolved coverage are explicit. Closed shadow internals are not expanded.");
        Set<FunctionalArea> leaves=new HashSet<>();
        long begin=System.nanoTime();
        try{
            driver.manage().timeouts().pageLoadTimeout(Duration.ofSeconds(120));
            driver.manage().window().setSize(new Dimension(1280,1024));
            navigate(driver,url,acquisition,settle);
            acquisition.put("viewport",driver.executeScript("return {innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio};"));
            acquisition.put("browserCapabilities",driver.getCapabilities().asMap());
            Map<String,Object> initial=active(driver);
            String previous=null;
            if(initial!=null){previous=(String)initial.get("xpath");order.add(previous);locators.put(previous,(List<Map<String,Object>>)initial.get("steps"));}
            int boundaryStreak=0;Map<String,Integer> repeats=new HashMap<>();
            boolean complete=false;String termination="tab-limit";
            for(int press=1;press<=cap;press++){
                driver.switchTo().defaultContent();new Actions(driver).sendKeys(Keys.TAB).perform();Thread.sleep(100);
                Map<String,Object> focus=active(driver);
                if(focus==null){
                    actions.add(Map.of("press",press,"key","TAB","boundary",true));boundaryStreak++;
                    if(boundaryStreak>=3&&!order.isEmpty()){complete=true;termination="document-boundary";break;}
                    if(boundaryStreak>=3&&order.isEmpty()){
                        driver.switchTo().defaultContent();Map<String,Object> state=ready(driver,settle);acquisition.put("emptyWalkReadiness",state);
                        if(press>=12){complete=((Number)state.get("count")).intValue()==0;termination=complete?"empty-initial-focus-graph":"no-native-focus-despite-candidates";break;}
                        Thread.sleep(500);
                    }
                    continue;
                }
                String id=(String)focus.get("xpath");
                actions.add(Map.of("press",press,"key","TAB","xpath",id,"tag",focus.get("tag"),"contextDepth",((List<?>)focus.get("steps")).size()));
                if(locators.containsKey(id)){
                    if(boundaryStreak>0&&!order.isEmpty()&&id.equals(order.get(0))){complete=true;termination="wrapped-after-boundary";break;}
                    int visits=repeats.getOrDefault(id,0)+1;repeats.put(id,visits);
                    boolean segmented=focus.get("tag").equals("input")&&((String)focus.get("type")).matches("date|time|datetime-local|month|week");
                    if(visits>=(segmented?21:3)){termination="confirmed-focus-cycle";break;}
                }else{
                    order.add(id);locators.put(id,(List<Map<String,Object>>)focus.get("steps"));repeats.clear();
                    if(previous!=null&&!previous.equals(id))graphEdges.add(Map.of("source",previous,"target",id,"key","TAB"));
                }
                previous=id;boundaryStreak=0;
                if(press%100==0)System.out.println("Acquisition progress: "+press+" TABs; "+order.size()+" distinct targets");
            }
            acquisition.put("termination",termination);acquisition.put("complete",complete);
            acquisition.put("fullDocumentTraversal",complete);acquisition.put("reachableTargetCount",order.size());
            if(order.isEmpty())diagnoseEmptyReplay(driver,url,acquisition,settle);
            if(!order.isEmpty()){
                // Same fresh-state feature extraction as the upstream workflow, with context-aware resolution.
                navigate(driver,url,acquisition,settle);leaves=collectFeatures(driver,order,locators,nodes);
            }
        }catch(Exception error){acquisition.put("complete",false);acquisition.put("error",error.toString());throw error;}
        finally{
            acquisition.put("acquisitionSeconds",(System.nanoTime()-begin)/1e9);
            JSON.writerWithDefaultPrettyPrinter().writeValue(output.resolve("acquisition.json").toFile(),acquisition);
            driver.quit();
        }
        if(options.getOrDefault("acquire-only","false").equals("true"))return;
        if(order.isEmpty()){
            for(String name:List.of("Skip","Re-enter","Opposite","LeftChoice","VerticalAscent","Top"))System.out.println(name+" edges: 0");
            Map<String,Object> result=new LinkedHashMap<>();result.put("system","LYNX (original detection with portable acquisition)");
            result.put("url",url);result.put("candidateCount",0);result.put("findings",new ArrayList<>());result.put("flagged",false);
            result.put("judgmentStatus",acquisition.containsKey("unavailableReason")?"UNRESOLVED_SAVED_PAGE_REPLAY":Boolean.TRUE.equals(acquisition.get("complete"))?"NO_INITIAL_FOCUS_TARGETS":"UNRESOLVED_ACQUISITION");
            result.put("acquisitionSeconds",acquisition.get("acquisitionSeconds"));result.put("totalSeconds",(System.nanoTime()-begin)/1e9);
            JSON.writerWithDefaultPrettyPrinter().writeValue(output.resolve("result.json").toFile(),result);return;
        }
        UIGraphState graph=makeGraph(order,leaves,graphEdges);
        long treeStart = System.nanoTime();
        ContextTree tree = makeTree(config, subject, leaves);
        long detectStart = System.nanoTime();
        Set<UIGraphEdge> failures = FindFailures(tree, graph, config, subject);
        long end = System.nanoTime();
        SaveDetectedFailures(failures, config, subject, "DetectedLNFs.txt");
        List<Map<String, Object>> findings = new ArrayList<>();
        for (UIGraphEdge edge : failures) findings.add(Map.of(
            "source", edge.getV1().getXpath(), "target", edge.getV2().getXpath(),
            "key", edge.getVar(), "sc", "2.4.3"));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("system", "LYNX (original detection with portable acquisition)");
        result.put("url", url); result.put("candidateCount", order.size());
        result.put("findings", findings); result.put("flagged", !findings.isEmpty());
        result.put("acquisitionSeconds", acquisition.get("acquisitionSeconds"));
        result.put("contextTreeSeconds", (detectStart - treeStart) / 1e9);
        result.put("detectionSeconds", (end - detectStart) / 1e9);
        result.put("totalSeconds", (end - begin) / 1e9);
        JSON.writerWithDefaultPrettyPrinter().writeValue(output.resolve("result.json").toFile(), result);
    }
}
